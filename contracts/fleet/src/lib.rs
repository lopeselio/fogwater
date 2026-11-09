//! Fogwater: sealed-fleet sea battles on NEAR.
//!
//! A captain's fleet never goes onchain until the battle is decided. Before the first shot, each
//! captain posts a Merkle root over the 100 cells of their sea (DESIGN.md, "Sealed fleets"):
//!
//!   salt(cell)  = hex(sha256("fogwater|salt|<seed>|<cell>"))
//!   leaf(cell)  = sha256("fogwater|leaf|<game>|<cell>|<0|1>|<salt(cell)>")
//!   padding     = sha256("fogwater|pad") up to 128 leaves; node = sha256(left ‖ right)
//!
//! - **Every answer is checked.** A shot is answered by opening that one leaf (occupancy, salt and 7
//!   sibling hashes). The contract refuses an answer that doesn't hash to the sealed root, so nobody
//!   can call a hit a miss, and no other cell is revealed.
//! - **Every fleet is checked.** When a fleet has taken 17 hits, both captains reveal their seed and
//!   ship placements. The contract rebuilds the tree from them: the fleet must be legal (5 ships,
//!   straight, on the sea, no overlap), produce the sealed root, and agree with every "sunk" report.
//!   A fleet that fails loses. A sea with more misses than a legal fleet allows (83) loses at once.
//! - **Turns and clocks.** Shots alternate. A seat that doesn't act within the game's time limit
//!   can be timed out by anyone.
//!
//! A friend game starts with seat 2 "open"; the referee fills it when the friend opens the link.
//!
//! Seats are either NEAR accounts (signed-in players) or labels the game server speaks for
//! ("guest:…" players, "ai:…" admirals). Signed-in players seal their own fleet from their wallet;
//! the server (the referee) relays shots and answers for everyone, which it can't forge: an answer
//! only verifies with the salts that live in the captain's browser.

use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

#[cfg(test)]
mod tests;

pub const SIZE: u8 = 10;
pub const CELLS: u8 = 100;
pub const FLEET: [u8; 5] = [5, 4, 3, 3, 2];
pub const FLEET_CELLS: usize = 17;
pub const MAX_MISSES: usize = 83;
pub const DEPTH: usize = 7;
pub const LEAVES: usize = 128;

pub const PLACING: u8 = 0;
pub const PLAYING: u8 = 1;
pub const REVEAL: u8 = 2;
pub const DONE: u8 = 3;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Shot {
    pub cell: u8,
    pub hit: bool,
    /// the ship this shot sank, as reported by the defender (checked at reveal)
    pub sunk: Option<u8>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Placement {
    pub start: u8,
    pub vertical: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum Move {
    /// `seat` fires at `cell`
    Fire { seat: u8, cell: u8 },
    /// `seat` answers the pending shot by opening that cell's leaf
    Answer { seat: u8, cell: u8, occupied: bool, salt: String, proof: Vec<String>, sunk: Option<u8> },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Game {
    pub seats: [String; 2],
    pub roots: [Option<String>; 2],
    pub phase: u8,
    pub turn: u8,
    /// (shooter, cell) of a shot not yet answered
    pub pending: Option<(u8, u8)>,
    /// shots fired BY each seat
    pub shots: [Vec<Shot>; 2],
    pub revealed: [bool; 2],
    pub winner: Option<u8>,
    pub reason: String,
    pub timeout_s: u32,
    pub created_ms: u64,
    pub updated_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stats {
    pub games: u32,
    pub wins: u32,
    pub losses: u32,
    /// fewest shots in a won game (0 = none yet)
    pub best: u16,
    pub ships_sunk: u32,
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Games,
    Stats,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Fogwater {
    owner: AccountId,
    referee: AccountId,
    games: LookupMap<String, Game>,
    stats: IterableMap<AccountId, Stats>,
    played: u64,
}

fn sha(s: &str) -> Vec<u8> {
    env::sha256(s.as_bytes())
}

fn node(a: &[u8], b: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(64);
    buf.extend_from_slice(a);
    buf.extend_from_slice(b);
    env::sha256(&buf)
}

fn is_hex32(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn cell_salt(seed: &str, cell: u8) -> String {
    hex::encode(sha(&format!("fogwater|salt|{seed}|{cell}")))
}

pub fn leaf(game: &str, cell: u8, occupied: bool, salt: &str) -> Vec<u8> {
    sha(&format!("fogwater|leaf|{game}|{cell}|{}|{salt}", occupied as u8))
}

/// Does this opening hash up to `root`?
pub fn verify_opening(game: &str, root: &str, cell: u8, occupied: bool, salt: &str, proof: &[String]) -> bool {
    if cell >= CELLS || !is_hex32(salt) || proof.len() != DEPTH || !proof.iter().all(|p| is_hex32(p)) {
        return false;
    }
    let mut acc = leaf(game, cell, occupied, salt);
    let mut i = cell as usize;
    for sib in proof {
        let s = hex::decode(sib).unwrap();
        acc = if i & 1 == 1 { node(&s, &acc) } else { node(&acc, &s) };
        i >>= 1;
    }
    hex::encode(acc) == root
}

/// Lays a fleet on the sea: ship index per cell, or None if the fleet isn't legal.
pub fn layout(ships: &[Placement]) -> Option<Vec<i8>> {
    if ships.len() != FLEET.len() {
        return None;
    }
    let mut board = vec![-1i8; CELLS as usize];
    for (k, p) in ships.iter().enumerate() {
        let len = FLEET[k];
        if p.start >= CELLS {
            return None;
        }
        let (r, c) = (p.start / SIZE, p.start % SIZE);
        if (p.vertical && r + len > SIZE) || (!p.vertical && c + len > SIZE) {
            return None;
        }
        for i in 0..len {
            let cell = (p.start + i * if p.vertical { SIZE } else { 1 }) as usize;
            if board[cell] != -1 {
                return None;
            }
            board[cell] = k as i8;
        }
    }
    Some(board)
}

/// The root a seed and a legal board produce.
pub fn root_of(game: &str, seed: &str, board: &[i8]) -> String {
    let mut level: Vec<Vec<u8>> = (0..CELLS).map(|c| leaf(game, c, board[c as usize] >= 0, &cell_salt(seed, c))).collect();
    let pad = sha("fogwater|pad");
    level.resize(LEAVES, pad);
    while level.len() > 1 {
        level = level.chunks(2).map(|p| node(&p[0], &p[1])).collect();
    }
    hex::encode(&level[0])
}

/// Checks a revealed fleet against the sealed root and everything reported about it. None = fine.
pub fn check_reveal(game_id: &str, root: &str, seed: &str, ships: &[Placement], against: &[Shot]) -> Option<&'static str> {
    if !is_hex32(seed) {
        return Some("bad seed");
    }
    let board = match layout(ships) {
        Some(b) => b,
        None => return Some("illegal fleet"),
    };
    if root_of(game_id, seed, &board) != root {
        return Some("the revealed fleet isn't the one that was sealed");
    }
    let mut left = FLEET;
    for s in against {
        let k = board[s.cell as usize];
        if s.hit != (k >= 0) {
            return Some("an answer doesn't match the fleet");
        }
        let expect = if k >= 0 {
            left[k as usize] -= 1;
            if left[k as usize] == 0 { Some(k as u8) } else { None }
        } else {
            None
        };
        if s.sunk != expect {
            return Some("a false sunk report");
        }
    }
    None
}

fn is_label(seat: &str) -> bool {
    seat.starts_with("guest:") || seat.starts_with("ai:")
}

pub const OPEN: &str = "open";

fn valid_seat(s: &str) -> bool {
    (is_label(s) && s.len() <= 70) || s.parse::<AccountId>().is_ok()
}

#[near]
impl Fogwater {
    #[init]
    pub fn new(owner: AccountId, referee: AccountId) -> Self {
        Self { owner, referee, games: LookupMap::new(Key::Games), stats: IterableMap::new(Key::Stats), played: 0 }
    }

    // ---------- admin ----------

    pub fn set_referee(&mut self, referee: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.referee = referee;
    }

    // ---------- games ----------

    /// The referee opens a game between two seats ("guest:…", "ai:…" or a NEAR account).
    pub fn create_game(&mut self, id: String, seats: [String; 2], timeout_s: u32) {
        self.only_referee();
        require!(!id.is_empty() && id.len() <= 40 && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'), "bad game id");
        require!(!self.games.contains_key(&id), "game exists");
        require!(valid_seat(&seats[0]), "bad seat");
        require!(valid_seat(&seats[1]) || seats[1] == OPEN, "bad seat");
        require!((60..=7 * 86400).contains(&timeout_s), "timeout must be 1 minute to 7 days");
        let now = env::block_timestamp_ms();
        let game = Game {
            seats,
            roots: [None, None],
            phase: PLACING,
            turn: 0,
            pending: None,
            shots: [vec![], vec![]],
            revealed: [false, false],
            winner: None,
            reason: String::new(),
            timeout_s,
            created_ms: now,
            updated_ms: now,
        };
        self.games.insert(id.clone(), game);
        self.played += 1;
        env::log_str(&format!("EVENT_JSON:{{\"standard\":\"fogwater\",\"version\":\"1.0.0\",\"event\":\"create\",\"data\":{{\"game\":\"{id}\"}}}}"));
    }

    /// The friend who opened the link takes the open seat.
    pub fn fill_seat(&mut self, id: String, seat: String) {
        self.only_referee();
        let mut g = self.game(&id);
        require!(g.seats[1] == OPEN, "the seat is taken");
        require!(valid_seat(&seat) && seat != g.seats[0], "bad seat");
        g.seats[1] = seat;
        g.updated_ms = env::block_timestamp_ms();
        self.games.insert(id, g);
    }

    /// Seals a fleet. A signed-in captain calls this from their own wallet; the referee seals for guests and admirals.
    pub fn commit_fleet(&mut self, id: String, seat: u8, root: String) {
        let mut g = self.game(&id);
        require!(seat < 2, "bad seat");
        let who = env::predecessor_account_id();
        let s = &g.seats[seat as usize];
        require!(s != OPEN, "nobody has taken that seat yet");
        if is_label(s) {
            require!(who == self.referee, "only the referee seals for guests and admirals");
        } else {
            require!(who.as_str() == s, "seal your fleet from your own account");
        }
        require!(g.phase == PLACING, "fleets are already sealed");
        require!(g.roots[seat as usize].is_none(), "already sealed");
        require!(is_hex32(&root), "bad root");
        g.roots[seat as usize] = Some(root);
        if g.roots[0].is_some() && g.roots[1].is_some() {
            g.phase = PLAYING;
        }
        g.updated_ms = env::block_timestamp_ms();
        self.games.insert(id, g);
    }

    /// Shots and answers, in order. The referee relays them for everyone; a signed-in captain may also send their own.
    pub fn play(&mut self, id: String, moves: Vec<Move>) {
        require!(!moves.is_empty() && moves.len() <= 40, "1 to 40 moves");
        let mut g = self.game(&id);
        let who = env::predecessor_account_id();
        for m in moves {
            let seat = match &m {
                Move::Fire { seat, .. } | Move::Answer { seat, .. } => *seat,
            };
            require!(seat < 2, "bad seat");
            require!(who == self.referee || who.as_str() == g.seats[seat as usize], "not your seat");
            require!(g.phase == PLAYING, "the battle isn't on");
            match m {
                Move::Fire { seat, cell } => {
                    require!(g.pending.is_none(), "the last shot hasn't been answered");
                    require!(g.turn == seat, "not your turn");
                    require!(cell < CELLS, "off the sea");
                    require!(!g.shots[seat as usize].iter().any(|s| s.cell == cell), "already fired there");
                    g.pending = Some((seat, cell));
                }
                Move::Answer { seat, cell, occupied, salt, proof, sunk } => {
                    let (shooter, at) = g.pending.unwrap_or_else(|| env::panic_str("no shot to answer"));
                    require!(seat != shooter, "that shot wasn't aimed at you");
                    require!(cell == at, "answer for a different cell");
                    let root = g.roots[seat as usize].clone().unwrap();
                    require!(verify_opening(&id, &root, cell, occupied, &salt, &proof), "answer doesn't match the sealed fleet");
                    if let Some(k) = sunk {
                        require!(occupied, "a miss can't sink a ship");
                        require!((k as usize) < FLEET.len(), "no such ship");
                        require!(!g.shots[shooter as usize].iter().any(|s| s.sunk == Some(k)), "already sunk");
                    }
                    g.shots[shooter as usize].push(Shot { cell, hit: occupied, sunk: if occupied { sunk } else { None } });
                    g.pending = None;
                    g.turn = seat;
                    let shots = &g.shots[shooter as usize];
                    let hits = shots.iter().filter(|s| s.hit).count();
                    if hits >= FLEET_CELLS {
                        g.phase = REVEAL;
                        g.winner = Some(shooter);
                        g.reason = "fleet sunk".into();
                    } else if shots.len() - hits > MAX_MISSES {
                        g.winner = Some(shooter);
                        g.reason = "the defender's sea held fewer ships than a fleet".into();
                        self.finish(&id, &mut g);
                    }
                }
            }
        }
        g.updated_ms = env::block_timestamp_ms();
        self.games.insert(id, g);
    }

    /// Once the battle is decided, each captain reveals their seed and ships. A fleet that fails the check loses.
    pub fn reveal_fleet(&mut self, id: String, seat: u8, seed: String, ships: Vec<Placement>) -> bool {
        let mut g = self.game(&id);
        require!(seat < 2, "bad seat");
        let who = env::predecessor_account_id();
        require!(who == self.referee || who.as_str() == g.seats[seat as usize], "not your seat");
        require!(g.phase == REVEAL, "fleets are revealed once the battle is decided");
        require!(!g.revealed[seat as usize], "already revealed");
        let against = &g.shots[(1 - seat) as usize];
        let bad = check_reveal(&id, g.roots[seat as usize].as_deref().unwrap(), &seed, &ships, against);
        let ok = bad.is_none();
        if let Some(why) = bad {
            g.winner = Some(1 - seat);
            g.reason = format!("seat {} failed the fleet check: {why}", seat + 1);
            self.finish(&id, &mut g);
        } else {
            g.revealed[seat as usize] = true;
            if g.revealed[0] && g.revealed[1] {
                self.finish(&id, &mut g);
            }
        }
        g.updated_ms = env::block_timestamp_ms();
        self.games.insert(id, g);
        ok
    }

    /// Anyone may call this once the seat the game is waiting on has run out of time. That seat loses.
    pub fn claim_timeout(&mut self, id: String) {
        let mut g = self.game(&id);
        require!(g.phase != DONE, "the game is over");
        require!(g.seats[1] != OPEN, "nobody has joined yet");
        let now = env::block_timestamp_ms();
        require!(now >= g.updated_ms + g.timeout_s as u64 * 1000, "still within the time limit");
        let late = Self::waiting_on(&g);
        g.winner = Some(1 - late);
        g.reason = format!("seat {} ran out of time", late + 1);
        g.pending = None;
        self.finish(&id, &mut g);
        g.updated_ms = now;
        self.games.insert(id, g);
    }

    /// A captain strikes their colours.
    pub fn resign(&mut self, id: String, seat: u8) {
        let mut g = self.game(&id);
        require!(seat < 2, "bad seat");
        let who = env::predecessor_account_id();
        require!(who == self.referee || who.as_str() == g.seats[seat as usize], "not your seat");
        require!(g.phase != DONE, "the game is over");
        g.winner = Some(1 - seat);
        g.reason = format!("seat {} resigned", seat + 1);
        g.pending = None;
        self.finish(&id, &mut g);
        g.updated_ms = env::block_timestamp_ms();
        self.games.insert(id, g);
    }

    // ---------- views ----------

    pub fn get_game(&self, id: String) -> Option<Game> {
        self.games.get(&id).cloned()
    }

    pub fn stats_of(&self, account_id: AccountId) -> Stats {
        self.stats.get(&account_id).cloned().unwrap_or_default()
    }

    /// Signed-in captains by wins, then fewest shots in a win.
    pub fn leaderboard(&self, limit: u32) -> Vec<(AccountId, Stats)> {
        let mut all: Vec<(AccountId, Stats)> = self.stats.iter().map(|(a, s)| (a.clone(), s.clone())).collect();
        all.sort_by(|a, b| b.1.wins.cmp(&a.1.wins).then((if a.1.best == 0 { u16::MAX } else { a.1.best }).cmp(&(if b.1.best == 0 { u16::MAX } else { b.1.best }))));
        all.truncate(limit.min(100) as usize);
        all
    }

    pub fn get_config(&self) -> (AccountId, AccountId, u64) {
        (self.owner.clone(), self.referee.clone(), self.played)
    }

    // ---------- internals ----------

    fn only_referee(&self) {
        require!(env::predecessor_account_id() == self.referee, "referee only");
    }

    fn game(&self, id: &String) -> Game {
        self.games.get(id).cloned().unwrap_or_else(|| env::panic_str("no such game"))
    }

    fn waiting_on(g: &Game) -> u8 {
        match g.phase {
            PLACING => if g.roots[0].is_some() { 1 } else { 0 },
            PLAYING => match g.pending { Some((by, _)) => 1 - by, None => g.turn },
            _ => {
                let w = g.winner.unwrap_or(0);
                if g.revealed[w as usize] { 1 - w } else { w }
            }
        }
    }

    fn finish(&mut self, id: &str, g: &mut Game) {
        g.phase = DONE;
        let w = g.winner.unwrap_or(0) as usize;
        for seat in 0..2usize {
            let Ok(acct) = g.seats[seat].parse::<AccountId>() else { continue };
            if is_label(&g.seats[seat]) {
                continue;
            }
            let mut s = self.stats.get(&acct).cloned().unwrap_or_default();
            s.games += 1;
            s.ships_sunk += g.shots[seat].iter().filter(|x| x.sunk.is_some()).count() as u32;
            if seat == w {
                s.wins += 1;
                let n = g.shots[seat].len() as u16;
                if g.reason == "fleet sunk" && (s.best == 0 || n < s.best) {
                    s.best = n;
                }
            } else {
                s.losses += 1;
            }
            self.stats.insert(acct, s);
        }
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"fogwater\",\"version\":\"1.0.0\",\"event\":\"finish\",\"data\":{{\"game\":\"{id}\",\"winner\":{w}}}}}"
        ));
    }
}
