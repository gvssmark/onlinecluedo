import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getDatabase, ref, set, get, update, onValue, child
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
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

let myUid = null;
let myName = "";
let roomCode = null;
let unsubscribeRoom = null;
let roomState = null; // last snapshot value from DB

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

// ---------- Auth ----------
onAuthStateChanged(auth, (user) => {
  if (user) myUid = user.uid;
});
signInAnonymously(auth).catch(err => {
  document.getElementById("landingStatus").textContent = "Sign-in failed: " + err.message;
});
function ensureAuthed(cb){
  if (myUid){ cb(); return; }
  const unsub = onAuthStateChanged(auth, (user) => {
    if (user){ myUid = user.uid; unsub(); cb(); }
  });
}

// ---------- Landing tabs ----------
document.getElementById("tabCreate").addEventListener("click", () => {
  document.getElementById("tabCreate").classList.add("active");
  document.getElementById("tabJoin").classList.remove("active");
  document.getElementById("createForm").classList.remove("hidden");
  document.getElementById("joinForm").classList.add("hidden");
});
document.getElementById("tabJoin").addEventListener("click", () => {
  document.getElementById("tabJoin").classList.add("active");
  document.getElementById("tabCreate").classList.remove("active");
  document.getElementById("joinForm").classList.remove("hidden");
  document.getElementById("createForm").classList.add("hidden");
});

// ---------- Create room ----------
document.getElementById("createBtn").addEventListener("click", () => {
  const name = (document.getElementById("createName").value || "").trim();
  if (!name){ setLandingStatus("Enter your name first."); return; }
  const numPlayers = parseInt(document.getElementById("createNumPlayers").value, 10);
  const ruleMode = document.getElementById("createRuleMode").value;
  ensureAuthed(async () => {
    const code = genRoomCode();
    myName = name;
    const initial = {
      status: "lobby",
      numPlayers, ruleMode,
      hostUid: myUid,
      players: { [myUid]: { name, color: TOKEN_COLORS[0], seat: 0 } },
      order: [myUid],
      createdAt: Date.now(),
    };
    await set(ref(db, "rooms/" + code), initial);
    roomCode = code;
    watchRoom();
  });
});

// ---------- Join room ----------
document.getElementById("joinBtn").addEventListener("click", () => {
  const name = (document.getElementById("joinName").value || "").trim();
  const code = (document.getElementById("joinCode").value || "").trim().toUpperCase();
  if (!name){ setLandingStatus("Enter your name first."); return; }
  if (!code){ setLandingStatus("Enter the room code."); return; }
  ensureAuthed(async () => {
    const snap = await get(ref(db, "rooms/" + code));
    if (!snap.exists()){ setLandingStatus("No room with that code."); return; }
    const room = snap.val();
    if (room.status !== "lobby"){ setLandingStatus("That game has already started."); return; }
    const existing = room.players || {};
    if (existing[myUid]){
      // rejoining same browser/tab
      myName = existing[myUid].name; roomCode = code; watchRoom(); return;
    }
    const seat = Object.keys(existing).length;
    if (seat >= room.numPlayers){ setLandingStatus("That room is already full."); return; }
    myName = name;
    const order = (room.order || []).concat(myUid);
    await update(ref(db, "rooms/" + code), {
      ["players/" + myUid]: { name, color: TOKEN_COLORS[seat % TOKEN_COLORS.length], seat },
      order,
    });
    roomCode = code;
    watchRoom();
  });
});

function setLandingStatus(msg){ document.getElementById("landingStatus").textContent = msg; }

// ---------- Watch room state ----------
function watchRoom(){
  document.getElementById("landingPanel").classList.add("hidden");
  onValue(ref(db, "rooms/" + roomCode), (snap) => {
    roomState = snap.val();
    if (!roomState) return;
    render();
  });
}

function render(){
  if (!roomState) return;
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
  const hint = document.getElementById("lobbyHint");
  if (amHost){
    if (have >= need){
      startBtn.style.display = "block";
      hint.textContent = "Everyone's in — reorder above if you like, then start.";
    } else {
      startBtn.style.display = "none";
      hint.textContent = "Waiting for " + (need - have) + " more player(s) to join with the code above.";
    }
  } else {
    startBtn.style.display = "none";
    hint.textContent = have >= need ? "Waiting for the host to start the game." :
      "Waiting for " + (need - have) + " more player(s), then the host will start.";
  }
}

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
    status: "playing", envelope, hands, positions, notebooks,
    turnIndex: 0, suggestedThisTurn: false,
    log: [{msg: "Cards dealt. The envelope is sealed. Rule: " + (roomState.ruleMode==="family"?"Family":"Normal") + ".", ts: Date.now()}],
  });
});

// ---------- Board rendering ----------
let boardBuilt = false;
let reachable = new Set();
let lastLogCount = 0;

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
    t.className = "token"; t.style.background = p.color; t.title = p.name;
    t.textContent = p.name.slice(0,2).toUpperCase();
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
  if (roomState.status === "ended"){
    document.getElementById("winBanner").classList.remove("hidden");
    document.getElementById("winTitle").textContent = (roomState.players[roomState.winnerUid]||{}).name + " wins!";
    document.getElementById("winBody").textContent =
      "It was " + roomState.envelope.suspect + ", with the " + roomState.envelope.weapon + ", in the " + roomState.envelope.room + ".";
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
}

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

function renderLog(){
  const entries = roomState.log || [];
  if (entries.length === lastLogCount) return;
  const box = document.getElementById("logBox");
  box.innerHTML = "";
  entries.forEach(e => {
    const d = document.createElement("div");
    d.textContent = e.msg;
    box.appendChild(d);
  });
  box.scrollTop = box.scrollHeight;
  lastLogCount = entries.length;
}

function renderControls(){
  const mine = isMyTurn();
  const cp = roomState.players[currentTurnUid()];
  const myPos = roomState.positions[myUid];
  document.getElementById("rollBtn").disabled = !mine || roomState.status !== "playing" || !!roomState.diceTotal;
  document.getElementById("accuseBtn").disabled = !mine || roomState.status !== "playing";
  document.getElementById("endTurnBtn").disabled = !mine || !roomState.canEndTurn;
  document.getElementById("suggestBtn").disabled = true; // arriving in the next remote stage

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
});

document.getElementById("passageBtn").addEventListener("click", async () => {
  if (!isMyTurn()) return;
  const from = roomState.positions[myUid];
  const dest = SECRET_PASSAGES[from];
  if (!dest) return;
  await update(roomRef(""), { ["positions/" + myUid]: dest, canEndTurn: true });
  await pushLog(roomState.players[myUid].name + " slipped through the secret passage from " + ROOMS[from].name + " to " + ROOMS[dest].name + ".");
});

async function onCellClick(id){
  if (!isMyTurn() || !reachable.has(id)) return;
  await update(roomRef(""), { ["positions/" + myUid]: id, canEndTurn: true });
  reachable = new Set();
  const label = isRoom(id) ? ROOMS[id].name : "the hallway";
  await pushLog(roomState.players[myUid].name + " moved to " + label + ".");
}

document.getElementById("endTurnBtn").addEventListener("click", async () => {
  if (!isMyTurn() || !roomState.canEndTurn) return;
  const nextIdx = (roomState.turnIndex + 1) % roomState.order.length;
  reachable = new Set();
  document.getElementById("die1").textContent = "–";
  document.getElementById("die2").textContent = "–";
  document.getElementById("diceTotal").textContent = "–";
  await update(roomRef(""), { turnIndex: nextIdx, diceTotal: null, canEndTurn: false });
});

async function pushLog(msg){
  const entries = (roomState.log || []).concat([{msg, ts: Date.now()}]);
  await update(roomRef(""), { log: entries });
}

// ---------- Hand ----------
function renderHand(){
  const content = document.getElementById("handContent");
  const hand = (roomState.hands || {})[myUid] || [];
  content.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "card-grid";
  hand.forEach(card => {
    const chip = document.createElement("div");
    chip.className = "card-chip cat-" + catOf(card);
    chip.textContent = card;
    grid.appendChild(chip);
  });
  content.appendChild(grid);
}

// ---------- Notebook ----------
function renderNotebook(){
  const content = document.getElementById("nbContent");
  const nb = (roomState.notebooks || {})[myUid];
  if (!nb){ content.innerHTML = ""; return; }
  const order = roomState.order;
  const table = document.createElement("table");
  table.className = "notebook-table";
  const thead = document.createElement("tr");
  thead.innerHTML = "<th style='text-align:left;'>Card</th>" + order.map(uid => "<th>"+roomState.players[uid].name.slice(0,3)+"</th>").join("");
  table.appendChild(thead);
  CATS.forEach(cat => {
    cat.cards.forEach(card => {
      const tr = document.createElement("tr");
      const tdName = document.createElement("td"); tdName.className = "cardname"; tdName.textContent = card;
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
  content.innerHTML = "";
  content.appendChild(table);
  const legend = document.createElement("div");
  legend.className = "nb-legend";
  legend.innerHTML = "● have &nbsp; ✓ shown to you &nbsp; – known not held. Click a blank cell to mark your own guess.";
  content.appendChild(legend);
}

// ---------- Modal helper ----------
const overlay = document.getElementById("modalOverlay");
const modalBox = document.getElementById("modalBox");
function showModal(html){ modalBox.innerHTML = html; overlay.classList.add("open"); }
function closeModal(){ overlay.classList.remove("open"); modalBox.innerHTML = ""; }

// ---------- Accusation ----------
document.getElementById("accuseBtn").addEventListener("click", () => {
  if (!isMyTurn()) return;
  const suspectOpts = SUSPECTS.map(s => "<option>"+s+"</option>").join("");
  const weaponOpts = WEAPONS.map(w => "<option>"+w+"</option>").join("");
  const roomOpts = ROOM_NAMES.map(r => "<option>"+r+"</option>").join("");
  showModal(
    "<h3>Make an accusation</h3>" +
    "<p>Checked privately against the envelope — a wrong guess is never shown to anyone else.</p>" +
    "<label style='display:block;color:#cfc4a8;font-family:monospace;font-size:11px;margin-bottom:4px;'>Suspect</label>" +
    "<select id='accSuspect' style='width:100%;margin-bottom:10px;padding:8px;background:#111823;color:#ece4d3;border:1px solid #3a475a;border-radius:4px;'>"+suspectOpts+"</select>" +
    "<label style='display:block;color:#cfc4a8;font-family:monospace;font-size:11px;margin-bottom:4px;'>Weapon</label>" +
    "<select id='accWeapon' style='width:100%;margin-bottom:10px;padding:8px;background:#111823;color:#ece4d3;border:1px solid #3a475a;border-radius:4px;'>"+weaponOpts+"</select>" +
    "<label style='display:block;color:#cfc4a8;font-family:monospace;font-size:11px;margin-bottom:4px;'>Room</label>" +
    "<select id='accRoom' style='width:100%;margin-bottom:14px;padding:8px;background:#111823;color:#ece4d3;border:1px solid #3a475a;border-radius:4px;'>"+roomOpts+"</select>" +
    "<button class='block' id='accSubmitBtn'>Submit accusation</button>" +
    "<button class='block secondary' id='accCancelBtn'>Cancel</button>"
  );
  document.getElementById("accCancelBtn").addEventListener("click", closeModal);
  document.getElementById("accSubmitBtn").addEventListener("click", async () => {
    const suspect = document.getElementById("accSuspect").value;
    const weapon = document.getElementById("accWeapon").value;
    const room = document.getElementById("accRoom").value;
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
        await update(roomRef(""), { canEndTurn: true });
        await pushLog(roomState.players[myUid].name + " made an accusation. (Result kept private.)");
      });
    }
  });
});
