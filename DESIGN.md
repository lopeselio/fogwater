# Fogwater — design

## Pitch

The sea-battle game everyone has played on paper or in a chat app, played at night under fog, on NEAR.
Hidden information is the whole game, and on a public chain it's usually the first thing to leak. In Fogwater
nobody (your rival, the AI admiral, or our server) learns where your ships are, yet every "hit" and "miss"
is proven onchain.

Tracks: **Games With Real Economies** (games), **Privacy & Private AI**.

## Rules

- 10×10 sea, cells A1–J10 (index = row × 10 + col).
- Fleet, in this order: Dreadnought 5, Frigate 4, Corvette 3, Submarine 3, Cutter 2 (17 cells). Straight, inside the sea, no overlap; touching is allowed.
- Seat 1 fires first. Turns alternate, one shot each.
- A shot is answered "hit" or "miss"; the answer that finishes a ship also names it ("you sank my Frigate").
- 17 hits wins. Then both fleets are revealed and checked.

## Sealed fleets

A captain picks a secret 32-byte seed. For each cell:

```
salt(cell) = hex(sha256("fogwater|salt|<seed>|<cell>"))
leaf(cell) = sha256("fogwater|leaf|<gameId>|<cell>|<0|1>|<salt(cell)>")
```

The 100 leaves, padded with `sha256("fogwater|pad")` to 128, form a binary Merkle tree (`node = sha256(left ‖ right)`).
Only the root goes onchain (`commit_fleet`) before the first shot.

- **Answer:** the defender opens one leaf: occupancy, salt and 7 sibling hashes. The contract recomputes the root and refuses a mismatch. Nothing about other cells leaks (each salt is independent).
- **Reveal:** once a fleet has 17 hits, each captain reveals seed + placements. The contract rebuilds the tree from them. It must equal the sealed root, the fleet must be legal, and every "sunk" report must be exactly what the fleet implies. A fleet that fails loses, even if it "won".
- **Empty-sea cheat:** a board with fewer than 17 ship cells could never lose by hits. On any legal board a captain misses at most 83 times, so the 84th miss ends the game against the defender at once.
- **Clock:** each game has a per-move limit (2 h vs an admiral, 3 days between friends). Anyone can call `claim_timeout`; the seat the game was waiting on loses.

`packages/rules/src/commit.ts` and `contracts/fleet/src/lib.rs` implement the same bytes; a shared test vector pins them together.

## Who holds what

| | Holds |
|---|---|
| Your browser | your seed and placements (localStorage), your seat token |
| Game server | names, seat-token hashes, the admirals' secret fleets, the move log, NEAR AI lines |
| Contract `fogwater.testnet` | seats, roots, every shot and answer, reveals, results, the ledger |

The server relays shots and answers as the referee (`fogwater-ref.testnet`) in batches of up to 12 moves per `play` call. It can't forge an
answer: answers need salts it never sees. Signed-in captains seal their own fleet from their wallet, gasless (NEP-366
through `fogwater-relay.testnet`), so the root is provably theirs. Guests' and admirals' roots are sealed by the referee.

**Not proven by the chain:** the referee could submit a `Fire` for a captain at a cell they didn't pick (it can't fake an answer).
Guest seats are labels the server speaks for.

## Modes

- **Vs an admiral.** Three AI admirals: Old Brine (easy: chases neighbours of hits, otherwise random), Captain Marrow
  (medium: checkerboard hunt, density targeting), the Grey Widow (hard: counts every placement still possible for each
  afloat ship and fires at the most likely cell). They plan only from their own shots (`chart()` → `density()`), seeded,
  so a game replays the same way. `pnpm sim` reports mean shots to win (≈63 / 49 / 45). Their spoken lines come from a
  TEE-hosted model on NEAR AI Cloud, signed, stored in the proof bundle; the model never picks a shot.
- **Vs a friend, by link.** Like a chat-app game: create a challenge, send the link. Seat 2 is `open` onchain until the
  friend joins (`fill_seat`). Play live (WebSocket push) or one move a day.

## Sign-in and storage

- Guests play with no wallet. **Sign in with NEAR** uses Better Auth + better-near-auth (NEP-413 "Sign in to <host>",
  full-access key check) with NEAR Connect's wallet picker, the same as the other arcade games. Signed-in captains are
  seated as their account and ranked on the contract's ledger (`stats_of`, `leaderboard`).
- Game records are JSON files in `DATA_DIR/games` (an Azure Files share mounted at `/data` when hosted). Sessions are in memory.

## Scene

three.js, all voxels and procedural: an instanced ocean whose two 10×10 waters are calmer and checkered, wooden frames
with lanterns, an island lighthouse with a turning beam, a blocky moon and stars. Enemy waters sit under instanced fog
voxels that clear where shots land. Ships are built from boxes (hull, deck, masts, sails, stern lantern; the Submarine
has a conning tower). Cannonballs arc between the fleets; hits burn and smoke, misses splash. Sound is synthesised.
