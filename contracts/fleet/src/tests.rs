use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const VEC_ROOT: &str = "7a5606e628236c4074b2a5a2d7bf0606b160397a2ab31f645404a4bbd5b84774";
const VEC_SALT0: &str = "e5086d068eb856a5ecc84752087d5469eb161d83f74aa438d3c2a67b82af0d88";
const VEC_PROOF0: [&str; 7] = [
    "03d5e1854d7dafd6afbf408b0474ceeaacd2495a33868d6bbe48b838b2010091",
    "eb6155e5a597b656e8dc31cfbe4a9f405a3c48c3bac3038e1d61cee836b1386c",
    "00cbbcf47442407316f81e9b87d620d3b6c9ec5c5bcfb537a6962d9d6e035c8f",
    "9a3a6f8a4d904d5999cca0e13143c335b41f7356f9e9daa723649b6c941e86b5",
    "380e51418d06462b1a84935c8e519161fe7ecd8ebb7fde3321882626677dd37f",
    "79d22e1faa3bd946097352251bcf68177516856e6d1bbf240b0a6e5b6d13618e",
    "b2835043b237c365692a7b0ba4afe2af466d1b65f21ef228b106c3881d5e7fca",
];

fn rows() -> Vec<Placement> {
    (0..5).map(|k| Placement { start: k * 10, vertical: false }).collect()
}

fn ctx(who: &str, ms: u64) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(who.parse().unwrap())
        .block_timestamp(ms * 1_000_000)
        .build());
}

/// The secret side of a fleet, rebuilt here the same way the browser does it.
struct Fleet {

    seed: String,
    board: Vec<i8>,
    tree: Vec<Vec<Vec<u8>>>,
}

impl Fleet {
    fn new(game: &str, seed: &str, ships: &[Placement]) -> Self {
        let board = layout(ships).unwrap();
        let mut level: Vec<Vec<u8>> = (0..CELLS).map(|c| leaf(game, c, board[c as usize] >= 0, &cell_salt(seed, c))).collect();
        level.resize(LEAVES, env::sha256(b"fogwater|pad"));
        let mut tree = vec![level.clone()];
        while level.len() > 1 {
            level = level.chunks(2).map(|p| node(&p[0], &p[1])).collect();
            tree.push(level.clone());
        }
        Fleet { seed: seed.into(), board, tree }
    }
    fn root(&self) -> String {
        hex::encode(&self.tree[DEPTH][0])
    }
    fn answer(&self, seat: u8, cell: u8, against: &[Shot]) -> Move {
        let mut proof = vec![];
        let mut i = cell as usize;
        for d in 0..DEPTH {
            proof.push(hex::encode(&self.tree[d][i ^ 1]));
            i >>= 1;
        }
        let k = self.board[cell as usize];
        let sunk = if k >= 0 {
            let hits_on_k = against.iter().filter(|s| self.board[s.cell as usize] == k).count() + 1;
            if hits_on_k == FLEET[k as usize] as usize { Some(k as u8) } else { None }
        } else {
            None
        };
        Move::Answer { seat, cell, occupied: k >= 0, salt: cell_salt(&self.seed, cell), proof, sunk }
    }
}

fn setup(seats: [&str; 2]) -> (Fogwater, Fleet, Fleet) {
    ctx("ref.testnet", 1000);
    let mut c = Fogwater::new("owner.testnet".parse().unwrap(), "ref.testnet".parse().unwrap());
    c.create_game("g1".into(), [seats[0].into(), seats[1].into()], 3600);
    let a = Fleet::new("g1", &"a".repeat(64), &rows());
    let b = Fleet::new("g1", &"b".repeat(64), &rows());
    (c, a, b)
}

fn seal_both(c: &mut Fogwater, a: &Fleet, b: &Fleet) {
    c.commit_fleet("g1".into(), 0, a.root());
    c.commit_fleet("g1".into(), 1, b.root());
}

/// One full round: `seat` fires at `cell`, the other side answers.
fn shoot(c: &mut Fogwater, fleets: [&Fleet; 2], seat: u8, cell: u8) {
    let g = c.get_game("g1".into()).unwrap();
    let def = 1 - seat;
    let ans = fleets[def as usize].answer(def, cell, &g.shots[seat as usize]);
    c.play("g1".into(), vec![Move::Fire { seat, cell }, ans]);
}

#[test]
fn matches_the_typescript_vector() {
    let f = Fleet::new("vec", &"1".repeat(64), &rows());
    assert_eq!(f.root(), VEC_ROOT);
    assert_eq!(cell_salt(&"1".repeat(64), 0), VEC_SALT0);
    let proof: Vec<String> = VEC_PROOF0.iter().map(|s| s.to_string()).collect();
    assert!(verify_opening("vec", VEC_ROOT, 0, true, VEC_SALT0, &proof));
    assert!(!verify_opening("vec", VEC_ROOT, 0, false, VEC_SALT0, &proof));
    assert_eq!(root_of("vec", &"1".repeat(64), &layout(&rows()).unwrap()), VEC_ROOT);
}

#[test]
fn a_full_game_settles_and_counts_stats() {
    let (mut c, a, b) = setup(["alice.testnet", "guest:bob"]);
    ctx("alice.testnet", 2000);
    c.commit_fleet("g1".into(), 0, a.root());
    ctx("ref.testnet", 2000);
    c.commit_fleet("g1".into(), 1, b.root());
    assert_eq!(c.get_game("g1".into()).unwrap().phase, PLAYING);
    // A sweeps from the top (hits rows A–E), B sweeps from the bottom (water)
    let mut n = 0u8;
    while c.get_game("g1".into()).unwrap().phase == PLAYING {
        shoot(&mut c, [&a, &b], 0, n);
        if c.get_game("g1".into()).unwrap().phase != PLAYING {
            break;
        }
        shoot(&mut c, [&a, &b], 1, 99 - n);
        n += 1;
    }
    let g = c.get_game("g1".into()).unwrap();
    assert_eq!(g.phase, REVEAL);
    assert_eq!(g.winner, Some(0));
    assert_eq!(g.shots[0].iter().filter_map(|s| s.sunk).collect::<Vec<_>>(), vec![0, 1, 2, 3, 4]);
    assert!(c.reveal_fleet("g1".into(), 1, b.seed.clone(), rows()));
    assert!(c.reveal_fleet("g1".into(), 0, a.seed.clone(), rows()));
    let g = c.get_game("g1".into()).unwrap();
    assert_eq!(g.phase, DONE);
    let s = c.stats_of("alice.testnet".parse().unwrap());
    assert_eq!((s.games, s.wins, s.losses, s.ships_sunk), (1, 1, 0, 5));
    assert_eq!(s.best as usize, g.shots[0].len());
    assert_eq!(c.leaderboard(10).len(), 1); // guests aren't ranked
}

#[test]
#[should_panic(expected = "answer doesn't match the sealed fleet")]
fn a_lie_is_refused() {
    let (mut c, a, b) = setup(["guest:a", "guest:b"]);
    seal_both(&mut c, &a, &b);
    let Move::Answer { seat, cell, salt, proof, .. } = b.answer(1, 0, &[]) else { unreachable!() };
    c.play("g1".into(), vec![Move::Fire { seat: 0, cell: 0 }, Move::Answer { seat, cell, occupied: false, salt, proof, sunk: None }]);
}

#[test]
#[should_panic(expected = "seal your fleet from your own account")]
fn the_referee_cannot_seal_a_signed_in_fleet() {
    let (mut c, a, _) = setup(["alice.testnet", "guest:b"]);
    c.commit_fleet("g1".into(), 0, a.root());
}

#[test]
#[should_panic(expected = "not your turn")]
fn turns_alternate() {
    let (mut c, a, b) = setup(["guest:a", "guest:b"]);
    seal_both(&mut c, &a, &b);
    shoot(&mut c, [&a, &b], 0, 50);
    c.play("g1".into(), vec![Move::Fire { seat: 0, cell: 51 }]);
}

#[test]
#[should_panic(expected = "not your seat")]
fn strangers_cannot_play() {
    let (mut c, a, b) = setup(["guest:a", "guest:b"]);
    seal_both(&mut c, &a, &b);
    ctx("mallory.testnet", 3000);
    c.play("g1".into(), vec![Move::Fire { seat: 0, cell: 1 }]);
}

#[test]
fn a_moved_fleet_fails_the_reveal_and_loses() {
    let (mut c, a, b) = setup(["guest:a", "guest:b"]);
    seal_both(&mut c, &a, &b);
    let mut n = 0u8;
    while c.get_game("g1".into()).unwrap().phase == PLAYING {
        shoot(&mut c, [&a, &b], 0, n);
        if c.get_game("g1".into()).unwrap().phase != PLAYING {
            break;
        }
        shoot(&mut c, [&a, &b], 1, 99 - n);
        n += 1;
    }
    // the winner reveals a different fleet than they sealed
    let mut moved = rows();
    moved[4] = Placement { start: 95, vertical: false };
    assert!(!c.reveal_fleet("g1".into(), 0, a.seed.clone(), moved));
    let g = c.get_game("g1".into()).unwrap();
    assert_eq!((g.phase, g.winner), (DONE, Some(1)));
    assert!(g.reason.contains("isn't the one that was sealed"));
}

#[test]
fn a_false_sunk_report_loses_at_reveal() {
    let (mut c, a, b) = setup(["guest:a", "guest:b"]);
    seal_both(&mut c, &a, &b);
    // B claims the Cutter sank on A's first hit
    let Move::Answer { seat, cell, occupied, salt, proof, .. } = b.answer(1, 0, &[]) else { unreachable!() };
    c.play("g1".into(), vec![Move::Fire { seat: 0, cell: 0 }, Move::Answer { seat, cell, occupied, salt, proof, sunk: Some(4) }]);
    // the same fleet, revealed, contradicts that report
    let g = c.get_game("g1".into()).unwrap();
    assert_eq!(check_reveal("g1", g.roots[1].as_deref().unwrap(), &b.seed, &rows(), &g.shots[0]), Some("a false sunk report"));
}

#[test]
fn an_empty_sea_loses_on_misses() {
    ctx("ref.testnet", 1000);
    let mut c = Fogwater::new("owner.testnet".parse().unwrap(), "ref.testnet".parse().unwrap());
    c.create_game("g1".into(), ["guest:a".into(), "guest:b".into()], 3600);
    let a = Fleet::new("g1", &"a".repeat(64), &rows());
    // B's sea has no ships at all
    let mut b = Fleet::new("g1", &"b".repeat(64), &rows());
    b.board = vec![-1; 100];
    let mut level: Vec<Vec<u8>> = (0..CELLS).map(|cl| leaf("g1", cl, false, &cell_salt(&b.seed, cl))).collect();
    level.resize(LEAVES, env::sha256(b"fogwater|pad"));
    b.tree = vec![level.clone()];
    while level.len() > 1 {
        level = level.chunks(2).map(|p| node(&p[0], &p[1])).collect();
        b.tree.push(level.clone());
    }
    seal_both(&mut c, &a, &b);
    let mut n = 0u8;
    while c.get_game("g1".into()).unwrap().phase == PLAYING {
        shoot(&mut c, [&a, &b], 0, n);
        if c.get_game("g1".into()).unwrap().phase != PLAYING {
            break;
        }
        shoot(&mut c, [&a, &b], 1, 99 - n);
        n += 1;
    }
    let g = c.get_game("g1".into()).unwrap();
    assert_eq!((g.phase, g.winner), (DONE, Some(0)));
    assert_eq!(g.shots[0].len(), MAX_MISSES + 1);
}

#[test]
fn timeouts() {
    let (mut c, a, b) = setup(["guest:a", "guest:b"]);
    seal_both(&mut c, &a, &b);
    ctx("anyone.testnet", 1000 + 3_599_000);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut c2 = Fogwater::new("o.testnet".parse().unwrap(), "ref.testnet".parse().unwrap());
        c2.claim_timeout("nope".into());
    }))
    .is_err());
    ctx("anyone.testnet", 1000 + 3_601_000);
    c.claim_timeout("g1".into());
    let g = c.get_game("g1".into()).unwrap();
    assert_eq!((g.phase, g.winner), (DONE, Some(1))); // seat 0 was due to fire
}

#[test]
fn a_friend_fills_the_open_seat() {
    ctx("ref.testnet", 1000);
    let mut c = Fogwater::new("owner.testnet".parse().unwrap(), "ref.testnet".parse().unwrap());
    c.create_game("g1".into(), ["alice.testnet".into(), OPEN.into()], 3600);
    let a = Fleet::new("g1", &"a".repeat(64), &rows());
    ctx("alice.testnet", 1500);
    c.commit_fleet("g1".into(), 0, a.root());
    ctx("ref.testnet", 2000);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut c2 = Fogwater::new("o.testnet".parse().unwrap(), "ref.testnet".parse().unwrap());
        c2.create_game("g2".into(), ["guest:a".into(), OPEN.into()], 3600);
        c2.claim_timeout("g2".into());
    }))
    .is_err());
    c.fill_seat("g1".into(), "bob.testnet".into());
    assert_eq!(c.get_game("g1".into()).unwrap().seats[1], "bob.testnet");
    ctx("bob.testnet", 2500);
    let b = Fleet::new("g1", &"b".repeat(64), &rows());
    c.commit_fleet("g1".into(), 1, b.root());
    assert_eq!(c.get_game("g1".into()).unwrap().phase, PLAYING);
}
