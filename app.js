import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getDatabase, ref, set, get, update, onValue, child, runTransaction
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

// ---------- Firebase config (cluedo-online project) ----------
const firebaseConfig = {
  apiKey: "AIzaSyC0jTrWre5txRI1eNU5HEKWnbkwPM3z9KE",
  authDomain: "cluedo-online-f6a7c.firebaseapp.com",
  databaseURL: "https://cluedo-online-f6a7c-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "cluedo-online-f6a7c",
  storageBucket: "cluedo-online-f6a7c.firebasestorage.app",
  messagingSenderId: "512197916129",
  appId: "1:512197916129:web:89aea64c3cd6e0b3040ea0"
};
const fbApp = initializeApp(firebaseConfig);
const db = getDatabase(fbApp);
const auth = getAuth(fbApp);

// Bump this on every future update so it's obvious in the UI that GitHub Pages served the new build.
const BUILD_VERSION = 16;
document.getElementById("appTitle").textContent = "Cluedo Online " + BUILD_VERSION;

let myUid = null;
let myName = "";
let roomCode = null;
let unsubscribeRoom = null;
let roomState = null; // last snapshot value from DB
let retired = false;
let isCreatorSession = false;
let authReadyResolve;
const authReady = new Promise(res => { authReadyResolve = res; });

// Family allowlist for room *creation* only — joining a room never needs this.
// Source file had commas in place of dots (export artifact); normalized here.
const ALLOWED_EMAILS = {
  "deepti.mannava@gmail.com": true,
  "hgoteti@gmail.com": true,
  "hemanth.goteti@gmail.com": true,
  "rajavarapumadhulika@gmail.com": true,
  "sahiti.malyala@gmail.com": true,
  "gbtsundary@gmail.com": true,
  "subrahmanyam.malyala@gmail.com": true,
  "prasuna.malyala@gmail.com": true,
  "hngoteti@gmail.com": true,
  "komal.raj@gmail.com": true,
  "gvssmark@gmail.com": true,
};

// ---------- Board data model (same as local prototype) ----------
const ROOMS = {
  kitchen:      {name:"Kitchen",       r:0, c:0},
  ballroom:     {name:"Ballroom",      r:0, c:2},
  conservatory: {name:"Conservatory",  r:0, c:4},
  diningroom:   {name:"Dining Room",   r:2, c:0},
  library:      {name:"Library",       r:2, c:2},
  billiard:     {name:"Billiard Room", r:2, c:4},
  lounge:       {name:"Lounge",        r:4, c:0},
  hall:         {name:"Hall",          r:4, c:2},
  study:        {name:"Study",         r:4, c:4},
};
const HALLWAYS = {
  "kitchen-ballroom":      {r:0, c:1, a:"kitchen", b:"ballroom"},
  "ballroom-conservatory": {r:0, c:3, a:"ballroom", b:"conservatory"},
  "diningroom-library":    {r:2, c:1, a:"diningroom", b:"library"},
  "library-billiard":      {r:2, c:3, a:"library", b:"billiard"},
  "lounge-hall":           {r:4, c:1, a:"lounge", b:"hall"},
  "hall-study":            {r:4, c:3, a:"hall", b:"study"},
  "kitchen-diningroom":    {r:1, c:0, a:"kitchen", b:"diningroom"},
  "ballroom-library":      {r:1, c:2, a:"ballroom", b:"library"},
  "conservatory-billiard": {r:1, c:4, a:"conservatory", b:"billiard"},
  "diningroom-lounge":     {r:3, c:0, a:"diningroom", b:"lounge"},
  "library-hall":          {r:3, c:2, a:"library", b:"hall"},
  "billiard-study":        {r:3, c:4, a:"billiard", b:"study"},
};
const SECRET_PASSAGES = { kitchen:"study", study:"kitchen", conservatory:"lounge", lounge:"conservatory" };
const ADJ = {};
Object.keys(ROOMS).forEach(id => ADJ[id] = []);
Object.keys(HALLWAYS).forEach(id => ADJ[id] = []);
Object.entries(HALLWAYS).forEach(([hid, h]) => {
  ADJ[hid].push(h.a, h.b); ADJ[h.a].push(hid); ADJ[h.b].push(hid);
});
function isRoom(id){ return !!ROOMS[id]; }
const START_SQUARES = Object.keys(HALLWAYS);
const TOKEN_COLORS = ["#c25a5a","#6fae80","#7aa8d9","#d9b571","#b07ad9","#d97757"];

const SUSPECTS = ["Miss Scarlett","Colonel Mustard","Mrs White","Reverend Green","Mrs Peacock","Professor Plum"];
const WEAPONS  = ["Candlestick","Knife","Lead Pipe","Revolver","Rope","Wrench"];
const ROOM_NAMES = Object.values(ROOMS).map(r => r.name);
const CATS = [
  {key:"suspect", cards:SUSPECTS}, {key:"weapon", cards:WEAPONS}, {key:"room", cards:ROOM_NAMES},
];
const ALL_CARDS = SUSPECTS.concat(WEAPONS, ROOM_NAMES);
function catOf(card){
  if (SUSPECTS.includes(card)) return "suspect";
  if (WEAPONS.includes(card)) return "weapon";
  return "room";
}
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){ const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function computeReachable(start, steps){
  const dist = { [start]: 0 };
  const queue = [start];
  const dest = new Set();
  let qi = 0;
  while(qi < queue.length){
    const node = queue[qi++];
    const d = dist[node];
    if (d > 0) dest.add(node);
    if (isRoom(node) && node !== start) continue;
    if (d === steps) continue;
    (ADJ[node] || []).forEach(nb => {
      const nd = d + 1;
      if (nd <= steps && (dist[nb] === undefined || dist[nb] > nd)){
        dist[nb] = nd; queue.push(nb);
      }
    });
  }
  return dest;
}

function log(msg){
  const box = document.getElementById("logBox");
  if (!box) return;
  const d = document.createElement("div");
  d.textContent = msg;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}
function roomRef(path){ return ref(db, "rooms/" + roomCode + (path ? "/" + path : "")); }
function genRoomCode(){
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for(let i=0;i<4;i++) s += letters[Math.floor(Math.random()*letters.length)];
  return s;
}

// ---------- Session persistence (rejoin after accidental close) ----------
function saveSessionPointer(code, role){
  localStorage.setItem("cluedoActiveRoom", JSON.stringify({ roomCode: code, role, ts: Date.now() }));
}
function clearSessionPointer(){
  localStorage.removeItem("cluedoActiveRoom");
}
function cacheRoomData(){
  if (!roomCode || !myUid) return;
  const hand = (roomState.hands || {})[myUid] || [];
  const log = roomState.log || [];
  try{
    localStorage.setItem("cluedoCache_" + roomCode + "_" + myUid, JSON.stringify({ hand, log }));
  } catch(e){ /* storage full or unavailable — non-critical */ }
}
function renderFromCache(code, uid){
  try{
    const raw = localStorage.getItem("cluedoCache_" + code + "_" + uid);
    if (!raw) return;
    const cached = JSON.parse(raw);
    const grid = document.createElement("div");
    grid.className = "card-grid";
    (cached.hand || []).forEach(card => {
      const chip = document.createElement("div");
      chip.className = "card-chip cat-" + catOf(card);
      chip.textContent = card;
      grid.appendChild(chip);
    });
    document.getElementById("handContent").innerHTML = "";
    document.getElementById("handContent").appendChild(grid);
    const box = document.getElementById("logBox");
    box.innerHTML = "";
    (cached.log || []).forEach(e => {
      const d = document.createElement("div");
      d.textContent = e.msg;
      box.appendChild(d);
    });
    box.scrollTop = box.scrollHeight;
  } catch(e){ /* ignore malformed cache */ }
}

async function tryShowResumePanel(){
  const raw = localStorage.getItem("cluedoActiveRoom");
  if (!raw) return;
  let saved;
  try{ saved = JSON.parse(raw); } catch(e){ clearSessionPointer(); return; }
  if (!saved || !saved.roomCode) return;
  document.getElementById("resumePanel").classList.remove("hidden");
  document.getElementById("resumeCode").textContent = saved.roomCode;
  document.getElementById("resumeBtn").addEventListener("click", async () => {
    await authReady;
    if (!myUid){
      setLandingStatus("Could not restore your session — please Create or Join again.");
      return;
    }
    isCreatorSession = saved.role === "creator";
    roomCode = saved.roomCode;
    document.getElementById("resumePanel").classList.add("hidden");
    renderFromCache(roomCode, myUid);
    watchRoom();
  }, { once: true });
  document.getElementById("dismissResumeBtn").addEventListener("click", () => {
    clearSessionPointer();
    document.getElementById("resumePanel").classList.add("hidden");
  }, { once: true });
}
tryShowResumePanel();

// ---------- Auth ----------
// No eager anonymous sign-in on load: Create uses Google auth, Join uses lazy anonymous auth.
let authReadyFired = false;
onAuthStateChanged(auth, (user) => {
  if (user && !isCreatorSession) myUid = user.uid;
  if (!authReadyFired){ authReadyFired = true; authReadyResolve(); }
});
function ensureAnonAuthed(cb){
  if (myUid && !isCreatorSession){ cb(); return; }
  signInAnonymously(auth).then((cred) => { myUid = cred.user.uid; cb(); })
    .catch(err => setLandingStatus("Sign-in failed: " + err.message));
}

// ---------- Remembered name (this device) ----------
const savedName = localStorage.getItem("cluedoPlayerName") || "";
document.getElementById("joinName").value = savedName;
function rememberName(name){
  if (name) localStorage.setItem("cluedoPlayerName", name);
}

// ---------- Remembered photo (this device) ----------
let myPhotoDataUrl = localStorage.getItem("cluedoPlayerPhoto") || null;
if (myPhotoDataUrl){
  document.getElementById("photoPreview").innerHTML = "<img src='" + myPhotoDataUrl + "'>";
}
document.getElementById("photoInput").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const img = new Image();
  const reader = new FileReader();
  reader.onload = () => {
    img.onload = () => {
      const size = 80;
      const canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext("2d");
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width-side)/2, (img.height-side)/2, side, side, 0, 0, size, size);
      myPhotoDataUrl = canvas.toDataURL("image/jpeg", 0.6);
      localStorage.setItem("cluedoPlayerPhoto", myPhotoDataUrl);
      document.getElementById("photoPreview").innerHTML = "<img src='" + myPhotoDataUrl + "'>";
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

// Returns an avatar's inner HTML — photo if present, else initials.
function avatarInnerHtml(p){
  if (p && p.photo) return "<img src='" + p.photo + "'>";
  return ((p && p.name) || "?").slice(0,2).toUpperCase();
}

// ---------- Landing tabs ----------
// ---------- PWA: install detection, service worker, orientation lock, browser redirect ----------
function isStandalonePWA(){
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
if ("serviceWorker" in navigator){
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
if (isStandalonePWA() && window.screen && window.screen.orientation && window.screen.orientation.lock){
  window.screen.orientation.lock("portrait").catch(() => {});
}

document.getElementById("tabCreate").addEventListener("click", () => {
  document.getElementById("tabCreate").classList.add("active");
  document.getElementById("tabJoin").classList.remove("active");
  document.getElementById("joinForm").classList.add("hidden");
  if (isStandalonePWA()){
    // Google Sign-In popups are unreliable inside an installed standalone PWA —
    // send them to the regular browser instead of showing the create form.
    const url = window.location.href.split("#")[0];
    showModal(
      "<h3>Open in your browser</h3>" +
      "<p>Creating a room needs Google Sign-In, which doesn't work reliably inside the installed app. Please open this link in your regular browser (Chrome/Safari) instead:</p>" +
      "<p style='word-break:break-all;font-family:monospace;font-size:11px;color:#d9b571;'>" + url + "</p>" +
      "<button class='block' id='copyLinkBtn'>Copy link</button>" +
      "<button class='block secondary' id='closePwaNoticeBtn'>Close</button>"
    );
    document.getElementById("copyLinkBtn").addEventListener("click", () => {
      navigator.clipboard.writeText(url).catch(() => {});
      showToast("Link copied — paste it into your browser.");
    });
    document.getElementById("closePwaNoticeBtn").addEventListener("click", closeModal);
    document.getElementById("tabJoin").classList.add("active");
    document.getElementById("tabCreate").classList.remove("active");
    document.getElementById("joinForm").classList.remove("hidden");
    return;
  }
  document.getElementById("createForm").classList.remove("hidden");
});
document.getElementById("tabJoin").addEventListener("click", () => {
  document.getElementById("tabJoin").classList.add("active");
  document.getElementById("tabCreate").classList.remove("active");
  document.getElementById("joinForm").classList.remove("hidden");
  document.getElementById("createForm").classList.add("hidden");
});

// ---------- Create room (Google-authenticated, allowlisted) ----------
document.getElementById("googleSignInBtn").addEventListener("click", async () => {
  try{
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);
    const email = (result.user.email || "").toLowerCase();
    if (!ALLOWED_EMAILS[email]){
      setLandingStatus("That Google account isn't on the family list — ask the room creator to use their own account.");
      await signOut(auth);
      return;
    }
    myUid = result.user.uid;
    isCreatorSession = true;
    setLandingStatus("");
    document.getElementById("googleSignInStep").classList.add("hidden");
    document.getElementById("createSettingsStep").classList.remove("hidden");
    document.getElementById("signedInAsHint").textContent = "Signed in as " + email;
  } catch(err){
    setLandingStatus("Google sign-in failed: " + err.message);
  }
});

document.getElementById("createBtn").addEventListener("click", async () => {
  const numPlayers = parseInt(document.getElementById("createNumPlayers").value, 10);
  const ruleMode = document.getElementById("createRuleMode").value;
  const code = genRoomCode();
  const initial = {
    status: "lobby",
    numPlayers, ruleMode,
    hostUid: myUid,
    creatorUid: myUid,
    players: {}, order: [],
    createdAt: Date.now(),
  };
  await set(ref(db, "rooms/" + code), initial);
  if (lastRoomCodeForNotify){
    await update(ref(db, "rooms/" + lastRoomCodeForNotify), { nextRoomCode: code }).catch(() => {});
    lastRoomCodeForNotify = null;
  }
  roomCode = code;
  saveSessionPointer(code, "creator");
  watchRoom();
});

// ---------- Join room ----------
document.getElementById("joinBtn").addEventListener("click", () => {
  const name = (document.getElementById("joinName").value || "").trim();
  const code = (document.getElementById("joinCode").value || "").trim().toUpperCase();
  if (!name){ setLandingStatus("Enter your name first."); return; }
  if (!code){ setLandingStatus("Enter the room code."); return; }
  ensureAnonAuthed(async () => {
    const snap = await get(ref(db, "rooms/" + code));
    if (!snap.exists()){ setLandingStatus("No room with that code."); return; }
    const room = snap.val();
    const existing = room.players || {};
    if (existing[myUid]){
      // reconnecting as ourselves — allowed even if the game is already in progress
      myName = existing[myUid].name;
      roomCode = code;
      saveSessionPointer(code, "player");
      renderFromCache(roomCode, myUid);
      watchRoom();
      return;
    }
    if (room.status !== "lobby"){ setLandingStatus("That game has already started."); return; }
    const seat = Object.keys(existing).length;
    if (seat >= room.numPlayers){ setLandingStatus("That room is already full."); return; }
    myName = name;
    rememberName(name);
    const order = (room.order || []).concat(myUid);
    await update(ref(db, "rooms/" + code), {
      ["players/" + myUid]: { name, color: TOKEN_COLORS[seat % TOKEN_COLORS.length], seat, photo: myPhotoDataUrl || null },
      order,
    });
    roomCode = code;
    saveSessionPointer(code, "player");
    watchRoom();
  });
});

function setLandingStatus(msg){ document.getElementById("landingStatus").textContent = msg; }

// ---------- Watch room state ----------
function watchRoom(){
  document.getElementById("landingPanel").classList.add("hidden");
  document.getElementById("resumePanel").classList.add("hidden");
  document.getElementById("roomBadge").classList.remove("hidden");
  document.getElementById("roomBadgeCode").textContent = roomCode;
  unsubscribeRoom = onValue(ref(db, "rooms/" + roomCode), (snap) => {
    roomState = snap.val();
    if (!roomState || retired) return;
    render();
  });
}

function resetForNewRoom(){
  roomCode = null;
  retired = false;
  if (unsubscribeRoom){ unsubscribeRoom(); unsubscribeRoom = null; }
  roomState = null;
  document.getElementById("roomBadge").classList.add("hidden");
  document.getElementById("scrollArea").classList.remove("with-strip");
  document.getElementById("playerStrip").classList.add("hidden");
  document.getElementById("cluesRow").classList.add("hidden");
  document.body.classList.remove("my-turn");
  wasMyTurn = false;
  setActiveTab(0);
  ["lobbyPanel","gameArea","retiredPanel","hostEndedPanel"].forEach(id => document.getElementById(id).classList.add("hidden"));
  document.getElementById("landingPanel").classList.remove("hidden");
  document.getElementById("resumePanel").classList.add("hidden");
  document.getElementById("googleSignInStep").classList.add("hidden");
  document.getElementById("createSettingsStep").classList.remove("hidden");
  document.getElementById("tabCreate").classList.add("active");
  document.getElementById("tabJoin").classList.remove("active");
  document.getElementById("createForm").classList.remove("hidden");
  document.getElementById("joinForm").classList.add("hidden");
}
["newRoomBtn1","newRoomBtn2"].forEach(id => {
  document.getElementById(id).addEventListener("click", resetForNewRoom);
});
document.getElementById("newRoomBtn3").addEventListener("click", () => {
  lastRoomCodeForNotify = roomCode;
  resetForNewRoom();
});

function render(){
  if (!roomState) return;
  renderPauseOverlay();
  document.getElementById("newRoomBtn1").classList.toggle("hidden", !isCreatorSession);
  document.getElementById("newRoomBtn3").classList.toggle("hidden", !isCreatorSession);
  if (roomState.status === "ended_by_host"){
    clearSessionPointer();
    document.getElementById("lobbyPanel").classList.add("hidden");
    document.getElementById("gameArea").classList.add("hidden");
    document.getElementById("hostEndedPanel").classList.remove("hidden");
    if (unsubscribeRoom) unsubscribeRoom();
    return;
  }
  if (roomState.status === "lobby"){
    document.getElementById("lobbyPanel").classList.remove("hidden");
    document.getElementById("gameArea").classList.add("hidden");
    renderLobby();
  } else if (roomState.status === "playing" || roomState.status === "ended"){
    document.getElementById("lobbyPanel").classList.add("hidden");
    document.getElementById("gameArea").classList.remove("hidden");
    if (!boardBuilt) buildBoardDOM();
    renderGame();
  }
}

function renderLobby(){
  document.getElementById("scrollArea").classList.remove("with-strip");
  document.getElementById("playerStrip").classList.add("hidden");
  document.getElementById("cluesRow").classList.add("hidden");
  document.getElementById("lobbyCode").textContent = roomCode;
  const list = document.getElementById("lobbyPlayerList");
  list.innerHTML = "";
  const players = roomState.players || {};
  const order = roomState.order || Object.keys(players);
  const amHost = myUid === roomState.hostUid;
  order.forEach((uid, i) => {
    const p = players[uid];
    if (!p) return;
    const row = document.createElement("div");
    row.className = "lobby-row";
    row.innerHTML = '<div class="swatch" style="background:'+p.color+'"></div><div>'+(i+1)+'. '+p.name+'</div>' +
      (uid === roomState.hostUid ? '<div class="host-tag">HOST</div>' : '');
    if (amHost && order.length > 1){
      const arrows = document.createElement("div");
      arrows.className = "order-arrows";
      const upBtn = document.createElement("button");
      upBtn.textContent = "↑"; upBtn.disabled = i === 0;
      upBtn.addEventListener("click", () => reorderPlayers(i, i-1));
      const downBtn = document.createElement("button");
      downBtn.textContent = "↓"; downBtn.disabled = i === order.length-1;
      downBtn.addEventListener("click", () => reorderPlayers(i, i+1));
      arrows.appendChild(upBtn); arrows.appendChild(downBtn);
      row.appendChild(arrows);
    }
    list.appendChild(row);
  });
  const orderHint = document.getElementById("lobbyOrderHint");
  const shuffleBtn = document.getElementById("shuffleOrderBtn");
  if (amHost && order.length > 1){
    orderHint.style.display = "block";
    shuffleBtn.classList.remove("hidden");
  } else {
    orderHint.style.display = "none";
    shuffleBtn.classList.add("hidden");
  }
  const have = order.length, need = roomState.numPlayers;
  const startBtn = document.getElementById("startGameBtn");
  const endBtn = document.getElementById("endGameLobbyBtn");
  const hint = document.getElementById("lobbyHint");
  if (amHost){
    endBtn.style.display = "block";
    if (have >= need){
      startBtn.style.display = "block";
      hint.textContent = "Everyone's in — reorder above if you like, then start.";
    } else {
      startBtn.style.display = "none";
      hint.textContent = "Waiting for " + (need - have) + " more player(s) to join with the code above.";
    }
  } else {
    startBtn.style.display = "none";
    endBtn.style.display = "none";
    hint.textContent = have >= need ? "Waiting for the host to start the game." :
      "Waiting for " + (need - have) + " more player(s), then the host will start.";
  }

  const transferBlock = document.getElementById("transferHostBlock");
  const isCreatorStillHost = isCreatorSession && myUid === roomState.creatorUid && myUid === roomState.hostUid;
  if (isCreatorStillHost && order.length > 0){
    transferBlock.classList.remove("hidden");
    const sel = document.getElementById("transferHostSelect");
    sel.innerHTML = "";
    order.forEach(uid => {
      const opt = document.createElement("option");
      opt.value = uid; opt.textContent = players[uid].name;
      sel.appendChild(opt);
    });
  } else {
    transferBlock.classList.add("hidden");
  }
}

document.getElementById("transferHostBtn").addEventListener("click", async () => {
  const targetUid = document.getElementById("transferHostSelect").value;
  if (!targetUid) return;
  await update(roomRef(""), { hostUid: targetUid });
  retired = true;
  clearSessionPointer();
  if (unsubscribeRoom) unsubscribeRoom();
  document.getElementById("lobbyPanel").classList.add("hidden");
  document.getElementById("gameArea").classList.add("hidden");
  document.getElementById("retiredPanel").classList.remove("hidden");
});

async function endGameForEveryone(){
  if (myUid !== roomState.hostUid) return;
  if (!confirm("End the game for everyone? This can't be undone.")) return;
  await update(roomRef(""), { status: "ended_by_host", endedAt: Date.now() });
}
document.getElementById("endGameLobbyBtn").addEventListener("click", endGameForEveryone);
document.getElementById("endGameBtn").addEventListener("click", endGameForEveryone);

function renderPauseOverlay(){
  const overlayEl = document.getElementById("pauseOverlay");
  const paused = roomState.paused;
  if (!paused){
    overlayEl.classList.remove("show");
    return;
  }
  overlayEl.classList.add("show");
  const byName = (roomState.players && roomState.players[paused.by] && roomState.players[paused.by].name) || "Someone";
  document.getElementById("pauseByText").textContent = "Paused by " + byName + ". Play will resume when they're ready.";
  const resumeBtn2 = document.getElementById("resumeBtn2");
  resumeBtn2.classList.toggle("hidden", myUid !== paused.by);
}
document.getElementById("resumeBtn2").addEventListener("click", async () => {
  if (!roomState.paused || myUid !== roomState.paused.by) return;
  await update(roomRef(""), { paused: null });
});
document.getElementById("pauseBtn").addEventListener("click", async () => {
  if (!roomState || roomState.status !== "playing" || roomState.paused) return;
  await update(roomRef(""), { paused: { by: myUid, pausedAt: Date.now() } });
});

async function reorderPlayers(fromIdx, toIdx){
  const order = roomState.order.slice();
  const [moved] = order.splice(fromIdx, 1);
  order.splice(toIdx, 0, moved);
  await update(roomRef(""), { order });
}

document.getElementById("shuffleOrderBtn").addEventListener("click", async () => {
  if (myUid !== roomState.hostUid) return;
  const order = shuffle(roomState.order);
  await update(roomRef(""), { order });
});

document.getElementById("startGameBtn").addEventListener("click", async () => {
  const order = roomState.order;
  const n = order.length;
  const shuffled = shuffle(ALL_CARDS);
  const envelope = {
    suspect: shuffled.find(c => SUSPECTS.includes(c)),
    weapon:  shuffled.find(c => WEAPONS.includes(c)),
    room:    shuffled.find(c => ROOM_NAMES.includes(c)),
  };
  const remaining = shuffle(shuffled.filter(c => c!==envelope.suspect && c!==envelope.weapon && c!==envelope.room));
  const hands = {};
  order.forEach(uid => hands[uid] = []);
  remaining.forEach((card, i) => hands[order[i % n]].push(card));
  const positions = {};
  order.forEach((uid, i) => positions[uid] = START_SQUARES[i % START_SQUARES.length]);
  const notebooks = {};
  order.forEach(uid => {
    notebooks[uid] = {};
    ALL_CARDS.forEach(c => { notebooks[uid][c] = {}; });
    hands[uid].forEach(c => { notebooks[uid][c][uid] = "auto-have"; });
  });
  await update(ref(db, "rooms/" + roomCode), {
    status: "playing", envelope, hands, positions, notebooks, startedAt: Date.now(),
    turnIndex: 0, suggestedThisTurn: false, accusedThisTurn: false,
    log: [{msg: "Cards dealt. The envelope is sealed. Rule: " + (roomState.ruleMode==="family"?"Family":"Normal") + ".", ts: Date.now()}],
  });
});

// ---------- Board rendering ----------
let boardBuilt = false;
let reachable = new Set();
let lastLogCount = 0;

// ---------- Suggestion handshake trackers ----------
let currentPendingId = null;
let respondedForKey = null;
let responderModalOpen = false;
let suggesterModalOpen = false;
let lastProcessedEventCount = 0;
let finishingSuggestion = false;
let lastPublicKnowledgeCount = 0;
let suggesterProcessing = false;

function buildBoardDOM(){
  boardBuilt = true;
  const board = document.getElementById("board");
  board.innerHTML = "";
  const cellByPos = {};
  for(let r=0;r<5;r++){
    for(let c=0;c<5;c++){
      const div = document.createElement("div");
      div.className = "cell empty";
      div.style.gridRow = (r+1); div.style.gridColumn = (c+1);
      board.appendChild(div);
      cellByPos[r+"-"+c] = div;
    }
  }
  Object.entries(ROOMS).forEach(([id, room]) => {
    const div = cellByPos[room.r+"-"+room.c];
    div.className = "cell room"; div.dataset.id = id;
    const nm = document.createElement("div"); nm.className = "name"; nm.textContent = room.name;
    div.appendChild(nm);
    if (SECRET_PASSAGES[id]){
      const pb = document.createElement("div"); pb.className = "passage-btn";
      pb.textContent = "↔ " + ROOMS[SECRET_PASSAGES[id]].name;
      div.appendChild(pb);
    }
    const tok = document.createElement("div"); tok.className = "tokens"; div.appendChild(tok);
    div.addEventListener("click", () => onCellClick(id));
  });
  Object.entries(HALLWAYS).forEach(([id, h]) => {
    const div = cellByPos[h.r+"-"+h.c];
    div.className = "cell hallway"; div.dataset.id = id;
    const tok = document.createElement("div"); tok.className = "tokens"; div.appendChild(tok);
    div.addEventListener("click", () => onCellClick(id));
  });
}

function renderBoardTokens(){
  document.querySelectorAll(".cell").forEach(el => {
    el.classList.remove("reachable");
    const tok = el.querySelector(".tokens");
    if (tok) tok.innerHTML = "";
  });
  const players = roomState.players; const positions = roomState.positions || {};
  Object.keys(positions).forEach(uid => {
    const p = players[uid];
    const cell = document.querySelector('.cell[data-id="'+positions[uid]+'"]');
    if (!p || !cell) return;
    const tok = cell.querySelector(".tokens");
    const t = document.createElement("div");
    t.className = "token"; t.style.background = p.photo ? "#333" : p.color; t.style.borderColor = p.color; t.title = p.name;
    t.innerHTML = avatarInnerHtml(p);
    tok.appendChild(t);
  });
  if (isMyTurn()){
    reachable.forEach(id => {
      const cell = document.querySelector('.cell[data-id="'+id+'"]');
      if (cell) cell.classList.add("reachable");
    });
  }
}

function currentTurnUid(){ return roomState.order[roomState.turnIndex]; }
function isMyTurn(){ return currentTurnUid() === myUid && roomState.status === "playing"; }

function renderGame(){
  document.getElementById("scrollArea").classList.add("with-strip");
  document.getElementById("playerStrip").classList.remove("hidden");
  document.getElementById("cluesRow").classList.remove("hidden");
  document.getElementById("roomMeta").classList.remove("hidden");
  document.getElementById("ruleModeText").textContent = roomState.ruleMode === "family" ? "Family rule" : "Normal rule";
  renderPlayerStrip();
  renderWinOverlay();
  if (roomState.status === "ended"){
    ["rollBtn","suggestBtn","accuseBtn","endTurnBtn"].forEach(id => document.getElementById(id).disabled = true);
    document.getElementById("passageBtn").style.display = "none";
  }

  document.getElementById("turnName").textContent = (roomState.players[currentTurnUid()]||{}).name || "—";
  renderTurnOrder();
  renderBoardTokens();
  renderControls();
  renderHand();
  renderNotebook();
  renderLog();
  renderCluesRow();
  cacheRoomData();
  handlePendingSuggestion(roomState.pendingSuggestion || null);
  handlePublicKnowledge();

  const nowMyTurn = isMyTurn();
  if (nowMyTurn && !wasMyTurn){
    document.body.classList.add("my-turn");
    setActiveTab(1); // Turn tab
  } else if (!nowMyTurn){
    document.body.classList.remove("my-turn");
  }
  wasMyTurn = nowMyTurn;
}

// ---------- Help tab (static content, rendered once) ----------
document.getElementById("helpContent").innerHTML =
  "<h2 style='margin-top:0;'>How to play</h2>" +
  "<div class='help-section'><h3>Setting up</h3><p>An approved family member signs in with Google and creates a room, choosing the number of players and the suggestion rule (Normal or Family). Everyone else opens the app and joins with the room code and their name — no sign-in needed.</p></div>" +
  "<div class='help-section'><h3>Changing host</h3><p>The room creator never plays or gets dealt cards. Once enough players have joined, the creator can transfer hosting to one of them from the lobby, then close their tab — the game runs on without them.</p></div>" +
  "<div class='help-section'><h3>Playing your turn</h3><p>Roll the dice, then move that many steps to a room or a hallway square. Landing in a room lets you make a suggestion (name a suspect and weapon — the room is wherever you're standing). You can also make an accusation, but only while standing in the room you're naming.</p></div>" +
  "<div class='help-section'><h3>Suggestions</h3><p>The next player in turn order checks their hand. If they hold a matching card, they show it to you privately and the check ends there. Under Family rule, a player whose only match was already shown to you before may pass instead — checking then moves to the next player, but still stops the moment anyone shows a card.</p></div>" +
  "<div class='help-section'><h3>Winning</h3><p>An accusation is checked privately against the sealed envelope. Wrong guesses stay private and cost nothing — play continues. A correct accusation ends the game and reveals the solution to everyone.</p></div>" +
  "<div class='help-section'><h3>The notebook</h3><p>Cards are colored automatically as you learn about them — your own hand, cards shown to you, and anything logically deduced by elimination. Blank cells can be clicked to record your own guesses.</p></div>" +
  "<div class='help-credits'>Developed by GVSS with Claude</div>";

function renderPlayerStrip(){
  const strip = document.getElementById("playerStrip");
  strip.innerHTML = "";
  const cur = currentTurnUid();
  roomState.order.forEach(uid => {
    const p = roomState.players[uid];
    if (!p) return;
    const av = document.createElement("div");
    av.className = "player-avatar" + (uid === cur && roomState.status === "playing" ? " current-turn" : "");
    av.style.borderColor = p.color;
    if (!p.photo) av.style.background = p.color;
    av.title = p.name;
    av.innerHTML = avatarInnerHtml(p);
    strip.appendChild(av);
  });
}

let lastRoomCodeForNotify = null;

function renderWinOverlay(){
  const overlayEl = document.getElementById("winOverlay");
  const isWin = roomState.status === "ended";
  overlayEl.classList.toggle("show", isWin);
  if (!isWin) return;
  const winner = roomState.players[roomState.winnerUid];
  document.getElementById("winOverlayTitle").textContent = (winner ? winner.name : "Someone") + " wins!";
  document.getElementById("winOverlayBody").textContent =
    "It was " + roomState.envelope.suspect + ", with the " + roomState.envelope.weapon + ", in the " + roomState.envelope.room + ".";
  document.getElementById("newRoomBtn3").classList.toggle("hidden", !isCreatorSession);
  const nextHint = document.getElementById("nextRoomHint");
  if (roomState.nextRoomCode){
    nextHint.classList.remove("hidden");
    nextHint.textContent = "The host started a new game — room code: " + roomState.nextRoomCode;
  } else {
    nextHint.classList.add("hidden");
  }
}
document.getElementById("backToJoinBtn").addEventListener("click", () => {
  const nextCode = roomState && roomState.nextRoomCode;
  resetForNewRoom();
  if (nextCode) document.getElementById("joinCode").value = nextCode;
});

// ---------- Elapsed play timer ----------
setInterval(() => {
  if (!roomState || !roomState.startedAt || roomState.status !== "playing"){
    return;
  }
  const secs = Math.floor((Date.now() - roomState.startedAt) / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  const el = document.getElementById("playTimerText");
  if (el) el.textContent = mm + ":" + ss;
}, 1000);

function renderCluesRow(){
  const row = document.getElementById("cluesRow");
  const nb = (roomState.notebooks || {})[myUid];
  if (!nb){ row.textContent = ""; return; }
  const deduced = computeDeducedEnvelope(nb, roomState.order);
  const cards = Object.keys(deduced);
  row.textContent = cards.length ? ("Clues confirmed: " + cards.join(", ")) : "Clues confirmed: none yet";
}

// ---------- Tabs + swipe ----------
const TAB_IDS = ["board","turn","notebook","log","help"];
let activeTabIndex = 0;
let wasMyTurn = false;
function setActiveTab(idx){
  activeTabIndex = Math.max(0, Math.min(TAB_IDS.length - 1, idx));
  document.getElementById("tabTrack").style.transform = "translateX(-" + (activeTabIndex * 20) + "%)";
  document.querySelectorAll(".tab-bar-btn").forEach((b, i) => b.classList.toggle("active", i === activeTabIndex));
}
document.querySelectorAll(".tab-bar-btn").forEach((btn, i) => {
  btn.addEventListener("click", () => setActiveTab(i));
});
(function setupSwipe(){
  const vp = document.getElementById("tabViewport");
  let startX = null, startY = null, dragging = false;
  vp.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX; startY = e.touches[0].clientY; dragging = true;
  }, { passive: true });
  vp.addEventListener("touchend", (e) => {
    if (!dragging || startX === null) return;
    dragging = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)){
      if (dx < 0) setActiveTab(activeTabIndex + 1);
      else setActiveTab(activeTabIndex - 1);
    }
    startX = null; startY = null;
  }, { passive: true });
})();

function renderTurnOrder(){
  const list = document.getElementById("turnOrderList");
  list.innerHTML = "";
  const order = roomState.order;
  order.forEach((uid, i) => {
    const p = roomState.players[uid];
    if (!p) return;
    const chip = document.createElement("div");
    chip.className = "chip" + (i === roomState.turnIndex ? " current" : "");
    chip.innerHTML = '<div class="swatch" style="background:'+p.color+'"></div><div>'+(i+1)+'. '+p.name+'</div>' +
      (uid === myUid ? '<div class="you-tag">YOU</div>' : '');
    list.appendChild(chip);
  });
}

function highlightLogMessage(msg){
  let html = msg.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  (roomState.order || []).forEach(uid => {
    const p = roomState.players[uid];
    if (!p || !p.name) return;
    const re = new RegExp("\\b" + p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g");
    html = html.replace(re, "<span style='color:" + p.color + ";font-weight:bold;'>" + p.name + "</span>");
  });
  const colorFor = { suspect: "#c25a5a", weapon: "#d9b571", room: "#6fae80" };
  ALL_CARDS.forEach(card => {
    const re = new RegExp("\\b" + card.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g");
    html = html.replace(re, "<span style='color:" + colorFor[catOf(card)] + ";'>" + card + "</span>");
  });
  html = html.replace(/\bpassed\b/g, "<span style='color:#c25a5a;'>passed</span>");
  return html;
}

function renderLog(){
  const entries = roomState.log || [];
  if (entries.length === lastLogCount) return;
  const box = document.getElementById("logBox");
  box.innerHTML = "";
  const reversed = entries.slice().reverse();
  let currentGroup = null;
  let lastTurnUid = undefined;
  reversed.forEach(e => {
    if (e.turnUid !== lastTurnUid || !currentGroup){
      currentGroup = document.createElement("div");
      currentGroup.className = "log-turn-group";
      box.appendChild(currentGroup);
      lastTurnUid = e.turnUid;
    }
    const d = document.createElement("div");
    d.innerHTML = highlightLogMessage(e.msg);
    currentGroup.appendChild(d);
  });
  box.scrollTop = 0;
  lastLogCount = entries.length;
}

function renderControls(){
  const endGameBtn = document.getElementById("endGameBtn");
  endGameBtn.classList.toggle("hidden", myUid !== roomState.hostUid);
  if (myUid === roomState.creatorUid && !roomState.players[myUid]){
    ["rollBtn","suggestBtn","accuseBtn","endTurnBtn"].forEach(id => document.getElementById(id).disabled = true);
    document.getElementById("passageBtn").style.display = "none";
    document.getElementById("hintText").textContent = "You're the room admin — spectating only, no cards dealt to you.";
    return;
  }
  if (roomState.pendingSuggestion){
    ["rollBtn","suggestBtn","accuseBtn","endTurnBtn"].forEach(id => document.getElementById(id).disabled = true);
    document.getElementById("passageBtn").style.display = "none";
    const ps = roomState.pendingSuggestion;
    document.getElementById("hintText").textContent = ps.suggester === myUid
      ? "Waiting for players to respond to your suggestion…"
      : (ps.queue[ps.idx] === myUid ? "Check the popup — you may be able to disprove this." : "A suggestion is being resolved…");
    return;
  }
  const mine = isMyTurn();
  const cp = roomState.players[currentTurnUid()];
  const myPos = roomState.positions[myUid];
  document.getElementById("rollBtn").disabled = !mine || roomState.status !== "playing" || !!roomState.diceTotal;
  document.getElementById("accuseBtn").disabled = !mine || roomState.status !== "playing" || !!roomState.accusedThisTurn || !isRoom(myPos);
  document.getElementById("endTurnBtn").disabled = !mine || !roomState.canEndTurn;
  document.getElementById("suggestBtn").disabled = !mine || !isRoom(myPos) || !!roomState.suggestedThisTurn;

  const passageBtn = document.getElementById("passageBtn");
  if (mine && isRoom(myPos) && SECRET_PASSAGES[myPos] && !roomState.diceTotal){
    passageBtn.style.display = "block";
    passageBtn.textContent = "Take secret passage → " + ROOMS[SECRET_PASSAGES[myPos]].name;
  } else {
    passageBtn.style.display = "none";
  }

  const hint = document.getElementById("hintText");
  if (!mine){
    hint.textContent = "Waiting for " + (cp ? cp.name : "the next player") + "'s turn.";
  } else if (roomState.diceTotal && reachable.size){
    hint.textContent = "Rolled " + roomState.diceTotal + ". Click a highlighted square to move.";
  } else if (roomState.diceTotal){
    hint.textContent = "No square is reachable — end your turn.";
  } else if (isRoom(myPos)){
    hint.textContent = "You may make a suggestion, or roll to keep moving.";
  } else {
    hint.textContent = "Roll the dice, then click a highlighted square to move.";
  }
}

document.getElementById("rollBtn").addEventListener("click", async () => {
  if (!isMyTurn()) return;
  const d1 = 1 + Math.floor(Math.random()*6);
  const d2 = 1 + Math.floor(Math.random()*6);
  const total = d1 + d2;
  document.getElementById("die1").textContent = d1;
  document.getElementById("die2").textContent = d2;
  document.getElementById("diceTotal").textContent = total;
  reachable = computeReachable(roomState.positions[myUid], total);
  await update(roomRef(""), { diceTotal: total, canEndTurn: reachable.size === 0 });
  await pushLog((roomState.players[myUid].name) + " rolled " + d1 + " + " + d2 + " = " + total + ".");
  renderBoardTokens();
  if (reachable.size === 0) offerNextAction();
  else setTimeout(() => setActiveTab(0), 5000); // auto-shift to Board so they can pick a move
});

document.getElementById("passageBtn").addEventListener("click", async () => {
  if (!isMyTurn()) return;
  const from = roomState.positions[myUid];
  const dest = SECRET_PASSAGES[from];
  if (!dest) return;
  await update(roomRef(""), { ["positions/" + myUid]: dest, canEndTurn: true });
  await pushLog(roomState.players[myUid].name + " slipped through the secret passage from " + ROOMS[from].name + " to " + ROOMS[dest].name + ".");
  setTimeout(() => setActiveTab(1), 5000); // auto-shift back to Turn
});

async function onCellClick(id){
  if (!isMyTurn() || !reachable.has(id)) return;
  await update(roomRef(""), { ["positions/" + myUid]: id, canEndTurn: true });
  reachable = new Set();
  const label = isRoom(id) ? ROOMS[id].name : "the hallway";
  await pushLog(roomState.players[myUid].name + " moved to " + label + ".");
  if (!isRoom(id)) offerNextAction(); // landing in a room leaves suggestion still on the table
  else setTimeout(() => setActiveTab(1), 5000); // auto-shift back to Turn after choosing a room
}

async function endMyTurn(){
  if (!isMyTurn() || !roomState.canEndTurn) return;
  const nextIdx = (roomState.turnIndex + 1) % roomState.order.length;
  reachable = new Set();
  document.getElementById("die1").textContent = "–";
  document.getElementById("die2").textContent = "–";
  document.getElementById("diceTotal").textContent = "–";
  await update(roomRef(""), { turnIndex: nextIdx, diceTotal: null, canEndTurn: false, suggestedThisTurn: false, accusedThisTurn: false });
}
document.getElementById("endTurnBtn").addEventListener("click", endMyTurn);

function offerNextAction(){
  if (!isMyTurn() || overlay.classList.contains("open")) return;
  const canAccuse = !roomState.accusedThisTurn;
  showModal(
    "<h3>What next?</h3>" +
    "<p>" + (canAccuse ? "You can still make an accusation, or end your turn." : "Ready to end your turn?") + "</p>" +
    (canAccuse ? "<button class='block secondary' id='quickAccuseBtn'>Make an accusation</button>" : "") +
    "<button class='block' id='quickEndTurnBtn'>End turn</button>"
  );
  if (canAccuse){
    document.getElementById("quickAccuseBtn").addEventListener("click", () => {
      closeModal();
      openAccusationModal();
    });
  }
  document.getElementById("quickEndTurnBtn").addEventListener("click", () => {
    closeModal();
    endMyTurn();
  });
}

async function pushLog(msg){
  const turnUid = currentTurnUid();
  const entries = (roomState.log || []).concat([{msg, ts: Date.now(), turnUid}]);
  await update(roomRef(""), { log: entries });
}

document.getElementById("downloadLogBtn").addEventListener("click", () => {
  const entries = roomState ? (roomState.log || []) : [];
  const lines = entries.slice().reverse().map(e => "[" + new Date(e.ts).toLocaleTimeString() + "] " + e.msg);
  const header = "Cluedo Online build " + BUILD_VERSION + " — room " + roomCode + " — exported " + new Date().toLocaleString();
  let text = header + "\n" + "-".repeat(header.length) + "\n" + lines.join("\n") + "\n";

  // ---- TEMP DEBUG SECTION — only while the game is still in progress; stripped once finalized ----
  const gameFinalized = roomState && (roomState.status === "ended" || roomState.status === "ended_by_host");
  if (roomState && !gameFinalized){
    text += "\n\n===== DEBUG DATA (temporary — remove later) =====\n";
    text += "Rule mode: " + roomState.ruleMode + "\n";
    text += "Envelope (solution): " + JSON.stringify(roomState.envelope) + "\n";
    text += "Turn order: " + (roomState.order||[]).map(uid => (roomState.players[uid]||{}).name).join(" -> ") + "\n";
    text += "Current turn index: " + roomState.turnIndex + "\n\n";
    text += "Hands:\n";
    (roomState.order||[]).forEach(uid => {
      const p = roomState.players[uid] || {};
      const hand = (roomState.hands||{})[uid] || [];
      text += "  " + p.name + ": " + hand.join(", ") + "\n";
    });
    text += "\nPositions:\n";
    (roomState.order||[]).forEach(uid => {
      const p = roomState.players[uid] || {};
      text += "  " + p.name + ": " + ((roomState.positions||{})[uid] || "—") + "\n";
    });
    if (roomState.pendingSuggestion){
      text += "\nPending suggestion (in progress): " + JSON.stringify(roomState.pendingSuggestion) + "\n";
    }
  }
  // ---- END TEMP DEBUG SECTION ----

  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "cluedo-log-b" + BUILD_VERSION + "-" + (roomCode || "room") + "-" + Date.now() + ".txt";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ---------- Hand ----------
function renderHand(){
  const content = document.getElementById("handContent");
  const hand = (roomState.hands || {})[myUid] || [];
  const catOrder = { room: 0, suspect: 1, weapon: 2 };
  const sorted = hand.slice().sort((a, b) => catOrder[catOf(a)] - catOrder[catOf(b)]);
  const myShownTo = ((roomState.players[myUid] || {}).shownTo) || {};
  content.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "card-grid hand-board-grid";
  sorted.forEach(card => {
    const chip = document.createElement("div");
    chip.className = "card-chip hand-cell cat-" + catOf(card);
    const nameEl = document.createElement("div");
    nameEl.className = "hand-cell-name";
    nameEl.textContent = card;
    chip.appendChild(nameEl);
    const shownUids = Object.keys(myShownTo[card] || {});
    if (shownUids.length){
      const tok = document.createElement("div");
      tok.className = "tokens";
      shownUids.forEach(uid => {
        const p = roomState.players[uid];
        if (!p) return;
        const t = document.createElement("div");
        t.className = "token";
        t.style.background = p.photo ? "#333" : p.color; t.style.borderColor = p.color; t.title = p.name;
        t.innerHTML = avatarInnerHtml(p);
        tok.appendChild(t);
      });
      chip.appendChild(tok);
    }
    grid.appendChild(chip);
  });
  content.appendChild(grid);
}

// ---------- Notebook ----------
function computeDeducedEnvelope(nb, order){
  const myHand = (roomState.hands || {})[myUid] || [];
  const deduced = {}; // card -> true
  CATS.forEach(cat => {
    cat.cards.forEach(card => {
      if (myHand.includes(card)) return; // I hold it — definitely not the envelope, nothing to deduce
      const allOthersRuledOut = order.every(uid => {
        if (uid === myUid) return true; // covered by the hand check above
        return nb[card] && nb[card][uid] === "auto-no";
      });
      if (allOthersRuledOut) deduced[card] = true;
    });
  });
  return deduced;
}

function renderNotebook(){
  const content = document.getElementById("nbContent");
  const nb = (roomState.notebooks || {})[myUid];
  if (!nb){ content.innerHTML = ""; return; }
  const order = roomState.order;
  const deduced = computeDeducedEnvelope(nb, order);
  const deducedCards = Object.keys(deduced);
  if (deducedCards.length){
    const banner = document.createElement("div");
    banner.className = "deduction-banner";
    banner.textContent = "Deduced from elimination — must be in the envelope: " + deducedCards.join(", ");
    content.innerHTML = "";
    content.appendChild(banner);
  } else {
    content.innerHTML = "";
  }
  const table = document.createElement("table");
  table.className = "notebook-table";
  const thead = document.createElement("tr");
  thead.innerHTML = "<th style='text-align:left;'>Card</th>" + order.map(uid => "<th>"+roomState.players[uid].name.slice(0,3)+"</th>").join("");
  table.appendChild(thead);
  CATS.forEach(cat => {
    cat.cards.forEach(card => {
      const tr = document.createElement("tr");
      const tdName = document.createElement("td");
      const cardNb = nb[card] || {};
      const isMine = cardNb[myUid] === "auto-have";
      const isShown = Object.values(cardNb).some(v => v === "auto-shown");
      const nameClass = isMine ? "card-mine" : isShown ? "card-shown" : deduced[card] ? "card-deduced" : "";
      tdName.className = "cardname" + (nameClass ? " " + nameClass : "");
      tdName.textContent = card;
      tr.appendChild(tdName);
      order.forEach(uid => {
        const td = document.createElement("td");
        const state = (nb[card] && nb[card][uid]) || "";
        td.className = "nb-cell" + (state ? " " + state : "");
        td.textContent = state === "auto-have" ? "●" : state === "auto-shown" ? "✓" : state === "auto-no" ? "–" :
          state === "manual-yes" ? "●" : state === "manual-no" ? "–" : "";
        if (state === "" || state === "manual-yes" || state === "manual-no"){
          td.addEventListener("click", async () => {
            const cur = state;
            const next = cur === "" ? "manual-yes" : cur === "manual-yes" ? "manual-no" : "";
            await update(roomRef("notebooks/" + myUid + "/" + card), { [uid]: next });
          });
        }
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
  });
  content.appendChild(table);
  const legend = document.createElement("div");
  legend.className = "nb-legend";
  legend.innerHTML = "Card name: <span style='color:#8ed3a0'>green</span>=your hand, <span style='color:#e6c98a'>yellow</span>=shown to you, <span style='color:#e08a8a'>red</span>=deduced envelope. Grid: ● have · ✓ shown · – not held. Click a blank cell to mark your own guess.";
  content.appendChild(legend);
}

// ---------- Modal helper ----------
const overlay = document.getElementById("modalOverlay");
const modalBox = document.getElementById("modalBox");
function showModal(html){ modalBox.innerHTML = html; overlay.classList.add("open"); }
function closeModal(){ overlay.classList.remove("open"); modalBox.innerHTML = ""; }

let toastTimer = null;
function showToast(msg){
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove("show"); }, 3200);
}

// Returns a tick prefix for cards the viewer already knows the status of:
// in their own hand, already shown to them, or logically deduced as the envelope card.
function cardKnownPrefix(card){
  const myHand = (roomState.hands || {})[myUid] || [];
  if (myHand.includes(card)) return "✓ ";
  const nb = (roomState.notebooks || {})[myUid] || {};
  const cardNb = nb[card] || {};
  if (Object.values(cardNb).some(v => v === "auto-shown")) return "✓ ";
  const order = roomState.order || [];
  const allOthersRuledOut = order.every(uid => uid === myUid || cardNb[uid] === "auto-no");
  if (allOthersRuledOut) return "✓ ";
  return "";
}

// ---------- Suggestion (live handshake) ----------
document.getElementById("suggestBtn").addEventListener("click", () => {
  if (!isMyTurn()) return;
  const myPos = roomState.positions[myUid];
  if (!isRoom(myPos)) return;
  const roomName = ROOMS[myPos].name;
  const suspectOpts = SUSPECTS.map(s => "<option value='"+s+"'>"+cardKnownPrefix(s)+s+"</option>").join("");
  const weaponOpts = WEAPONS.map(w => "<option value='"+w+"'>"+cardKnownPrefix(w)+w+"</option>").join("");
  showModal(
    "<h3>Make a suggestion</h3>" +
    "<p>You suggest it happened in the <b>" + roomName + "</b> with:</p>" +
    "<p style='font-size:11px;color:#cfc4a8;'>✓ = already known to you (your hand, shown to you, or deduced)</p>" +
    "<label style='display:block;color:#cfc4a8;font-family:monospace;font-size:11px;margin-bottom:4px;'>Suspect</label>" +
    "<select id='sugSuspect' style='width:100%;margin-bottom:10px;padding:8px;background:#111823;color:#ece4d3;border:1px solid #3a475a;border-radius:4px;'>"+suspectOpts+"</select>" +
    "<label style='display:block;color:#cfc4a8;font-family:monospace;font-size:11px;margin-bottom:4px;'>Weapon</label>" +
    "<select id='sugWeapon' style='width:100%;margin-bottom:14px;padding:8px;background:#111823;color:#ece4d3;border:1px solid #3a475a;border-radius:4px;'>"+weaponOpts+"</select>" +
    "<button class='block' id='sugSubmitBtn'>Submit suggestion</button>" +
    "<button class='block secondary' id='sugCancelBtn'>Cancel</button>"
  );
  document.getElementById("sugCancelBtn").addEventListener("click", closeModal);
  document.getElementById("sugSubmitBtn").addEventListener("click", async () => {
    const suspect = document.getElementById("sugSuspect").value;
    const weapon = document.getElementById("sugWeapon").value;
    closeModal();
    const order = roomState.order;
    const startIdx = order.indexOf(myUid);
    const queue = [];
    for(let step=1; step<order.length; step++) queue.push(order[(startIdx+step) % order.length]);
    const pendingSuggestion = {
      id: Date.now(), suggester: myUid, suspect, weapon, room: roomName,
      ruleMode: roomState.ruleMode, queue, idx: 0, events: [],
    };
    await update(roomRef(""), {
      pendingSuggestion,
      suggestedThisTurn: true,
      ["players/" + myUid + "/lastSuggestion"]: { suspect, weapon, room: roomName },
    });
    await pushLog(roomState.players[myUid].name + " suggested " + suspect + " with the " + weapon + " in the " + roomName + ".");
  });
});

function handlePendingSuggestion(ps){
  if (!ps){ currentPendingId = null; return; }
  if (ps.id !== currentPendingId){
    currentPendingId = ps.id; respondedForKey = null;
    responderModalOpen = false; suggesterModalOpen = false;
    lastProcessedEventCount = 0; finishingSuggestion = false;
  }

  const responderUid = ps.queue[ps.idx];
  const key = ps.id + ":" + ps.idx;
  if (responderUid === myUid && respondedForKey !== key && !responderModalOpen && !suggesterModalOpen){
    responderModalOpen = true;
    respondedForKey = key;
    actAsResponder(ps);
  }

  if (ps.suggester === myUid){
    processSuggesterEvents(ps);
  }
}

async function actAsResponder(ps){
  const myHand = (roomState.hands || {})[myUid] || [];
  const trio = [ps.suspect, ps.weapon, ps.room];
  const matches = myHand.filter(c => trio.includes(c));
  if (matches.length === 0){
    showToast(roomState.players[ps.suggester].name + " suggested " + ps.suspect + " / " + ps.weapon + " / " + ps.room + " — you had nothing to show, passed automatically.");
    await pushSuggestionEvent(ps, { by: myUid, matched: false });
    await advanceQueue(ps, false);
    responderModalOpen = false;
    return;
  }
  if (ps.ruleMode === "normal"){
    showResponderModal(ps, matches, true);
    return;
  }
  const suggesterNb = (roomState.notebooks || {})[ps.suggester] || {};
  const fresh = matches.filter(c => !(suggesterNb[c] && suggesterNb[c][myUid] === "auto-shown"));
  if (fresh.length > 0) showResponderModal(ps, fresh, true);
  else showResponderModal(ps, matches, false);
}

function showResponderModal(ps, options, mandatory){
  const optBtns = options.map(c => "<button class='card-option' data-card='"+c+"' style='display:block;width:100%;text-align:left;background:#111823;border:1px solid #3a475a;border-radius:4px;padding:9px 10px;margin-bottom:6px;color:#ece4d3;font-family:monospace;font-size:12.5px;cursor:pointer;'>"+c+"</button>").join("");
  const passBtn = mandatory ? "" : "<button class='block secondary' id='sugPassBtn'>Pass — already shown</button>";
  showModal(
    "<h3>" + (mandatory ? "You can disprove this" : "Show again, or pass?") + "</h3>" +
    "<p>" + roomState.players[ps.suggester].name + " suggested <b>"+ps.suspect+"</b>, <b>"+ps.weapon+"</b>, <b>"+ps.room+"</b>. " +
    (mandatory ? "Pick one matching card to show them privately." : "You've already shown every matching card you hold — show one again, or pass.") + "</p>" +
    optBtns + passBtn
  );
  modalBox.querySelectorAll(".card-option").forEach(btn => {
    btn.addEventListener("click", async () => {
      const card = btn.dataset.card;
      closeModal();
      await pushSuggestionEvent(ps, { by: myUid, matched: true, card });
      await update(ref(db, "rooms/" + roomCode + "/players/" + myUid + "/shownTo/" + card), { [ps.suggester]: true });
      await advanceQueue(ps, true); // showing a card always ends the check, both rules
      responderModalOpen = false;
    });
  });
  const passBtnEl = document.getElementById("sugPassBtn");
  if (passBtnEl){
    passBtnEl.addEventListener("click", async () => {
      closeModal();
      await pushSuggestionEvent(ps, { by: myUid, matched: false });
      await advanceQueue(ps, false);
      responderModalOpen = false;
    });
  }
}

async function pushSuggestionEvent(ps, evt){
  const events = (ps.events || []).concat([{ ...evt, ts: Date.now() }]);
  await update(roomRef("pendingSuggestion"), { events });
}
async function advanceQueue(ps, stopHere){
  const newIdx = stopHere ? ps.queue.length : ps.idx + 1;
  await update(roomRef("pendingSuggestion"), { idx: newIdx });
}

async function processSuggesterEvents(ps){
  if (suggesterModalOpen || suggesterProcessing) return;
  const events = ps.events || [];
  if (lastProcessedEventCount < events.length){
    const evt = events[lastProcessedEventCount];
    if (evt.matched && evt.card){
      suggesterModalOpen = true;
      showModal(
        "<h3>Card shown to you</h3>" +
        "<p>" + roomState.players[evt.by].name + " showed you: <b>" + evt.card + "</b></p>" +
        "<button class='block' id='revealOkBtn'>Got it</button>"
      );
      document.getElementById("revealOkBtn").addEventListener("click", async () => {
        closeModal();
        suggesterProcessing = true;
        lastProcessedEventCount++;
        await update(ref(db, "rooms/" + roomCode + "/notebooks/" + myUid + "/" + evt.card), { [evt.by]: "auto-shown" });
        await pushLog(roomState.players[evt.by].name + " showed a card to " + roomState.players[myUid].name + " privately.");
        suggesterModalOpen = false;
        suggesterProcessing = false;
        if (roomState.pendingSuggestion) processSuggesterEvents(roomState.pendingSuggestion);
      });
      return;
    }
    suggesterProcessing = true;
    lastProcessedEventCount++;
    await pushLog(roomState.players[evt.by].name + " had nothing to show and passed.");
    suggesterProcessing = false;
    if (roomState.pendingSuggestion) processSuggesterEvents(roomState.pendingSuggestion);
    return;
  }
  if (ps.idx >= ps.queue.length && lastProcessedEventCount >= events.length && !finishingSuggestion){
    finishingSuggestion = true;
    suggesterProcessing = true;
    const anyMatched = events.some(e => e.matched);
    if (!anyMatched){
      const trio = [ps.suspect, ps.weapon, ps.room];
      const pk = (roomState.publicKnowledge || []).concat([{ trio, exceptUid: ps.suggester, ts: Date.now() }]);
      await update(roomRef(""), { publicKnowledge: pk });
      await pushLog("No one could disprove " + roomState.players[ps.suggester].name + "'s suggestion.");
    }
    await update(roomRef(""), { pendingSuggestion: null, canEndTurn: true });
    finishingSuggestion = false;
    suggesterProcessing = false;
    offerNextAction();
  }
}

function handlePublicKnowledge(){
  const list = roomState.publicKnowledge || [];
  if (lastPublicKnowledgeCount >= list.length) return;
  const newOnes = list.slice(lastPublicKnowledgeCount);
  lastPublicKnowledgeCount = list.length;
  const myNb = (roomState.notebooks || {})[myUid] || {};
  const updates = {};
  newOnes.forEach(entry => {
    roomState.order.forEach(uid => {
      if (uid === entry.exceptUid) return;
      entry.trio.forEach(card => {
        const cur = myNb[card] && myNb[card][uid];
        const isManualOrBlank = !cur || cur === "manual-yes" || cur === "manual-no";
        if (isManualOrBlank) updates["notebooks/" + myUid + "/" + card + "/" + uid] = "auto-no";
      });
    });
  });
  if (Object.keys(updates).length) update(roomRef(""), updates);
}

// ---------- Accusation ----------
function openAccusationModal(){
  if (!isMyTurn()) return;
  const myPos = roomState.positions[myUid];
  if (!isRoom(myPos)) return; // must be standing in the room you're accusing, same as suggestions
  const roomName = ROOMS[myPos].name;
  const lastSug = (roomState.players[myUid] || {}).lastSuggestion || {};
  const suspectOpts = SUSPECTS.map(s => "<option"+(s===lastSug.suspect?" selected":"")+">"+s+"</option>").join("");
  const weaponOpts = WEAPONS.map(w => "<option"+(w===lastSug.weapon?" selected":"")+">"+w+"</option>").join("");
  showModal(
    "<h3>Make an accusation</h3>" +
    "<p>Accusing in the <b>" + roomName + "</b> — checked privately against the envelope, a wrong guess is never shown to anyone else.</p>" +
    "<label style='display:block;color:#cfc4a8;font-family:monospace;font-size:11px;margin-bottom:4px;'>Suspect</label>" +
    "<select id='accSuspect' style='width:100%;margin-bottom:10px;padding:8px;background:#111823;color:#ece4d3;border:1px solid #3a475a;border-radius:4px;'>"+suspectOpts+"</select>" +
    "<label style='display:block;color:#cfc4a8;font-family:monospace;font-size:11px;margin-bottom:4px;'>Weapon</label>" +
    "<select id='accWeapon' style='width:100%;margin-bottom:14px;padding:8px;background:#111823;color:#ece4d3;border:1px solid #3a475a;border-radius:4px;'>"+weaponOpts+"</select>" +
    "<button class='block' id='accSubmitBtn'>Submit accusation</button>" +
    "<button class='block secondary' id='accCancelBtn'>Cancel</button>"
  );
  document.getElementById("accCancelBtn").addEventListener("click", closeModal);
  document.getElementById("accSubmitBtn").addEventListener("click", async () => {
    const suspect = document.getElementById("accSuspect").value;
    const weapon = document.getElementById("accWeapon").value;
    const room = roomName;
    const env = roomState.envelope;
    const correct = suspect === env.suspect && weapon === env.weapon && room === env.room;
    if (correct){
      showModal(
        "<h3>Correct!</h3>" +
        "<p>You solved it: <b>"+suspect+"</b> with the <b>"+weapon+"</b> in the <b>"+room+"</b>.</p>" +
        "<button class='block' id='winOkBtn'>Reveal to everyone</button>"
      );
      document.getElementById("winOkBtn").addEventListener("click", async () => {
        closeModal();
        await update(roomRef(""), { status: "ended", winnerUid: myUid });
        await pushLog(roomState.players[myUid].name + " correctly accused " + env.suspect + " / " + env.weapon + " / " + env.room + " and won!");
      });
    } else {
      showModal(
        "<h3>Wrong</h3>" +
        "<p>That's not it — but no one else will know what you guessed. Play continues.</p>" +
        "<button class='block' id='accOkBtn'>OK</button>"
      );
      document.getElementById("accOkBtn").addEventListener("click", async () => {
        closeModal();
        await update(roomRef(""), { canEndTurn: true, accusedThisTurn: true });
        await pushLog(roomState.players[myUid].name + " made an accusation. (Result kept private.)");
        offerNextAction();
      });
    }
  });
}
document.getElementById("accuseBtn").addEventListener("click", openAccusationModal);
