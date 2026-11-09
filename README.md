# Fogwater

A night sea battle on NEAR, in voxels. Place your fleet, seal it, and trade cannon fire with an AI admiral or a friend. Your fleet is **sealed onchain as a Merkle root** before the first shot, every "hit" or "miss" is **proven against that seal by the contract**, and both fleets are **revealed and checked** when the last ship sinks. Nobody sees your ships until then: not your rival, not the AI, not our server.

Built for NEAR HACKATHON (Nov 2026). Tracks: **Games With Real Economies**, **Privacy & Private AI**. Design: [DESIGN.md](DESIGN.md).

- Contract (testnet): [`fogwater.testnet`](https://testnet.nearblocks.io/address/fogwater.testnet). Referee: [`fogwater-ref.testnet`](https://testnet.nearblocks.io/address/fogwater-ref.testnet). Gasless relayer: `fogwater-relay.testnet`.
- Hosted: https://fogwater.lopeselio.online/, also inside the NEAR Arcade at https://arcade.lopeselio.online/fogwater.

## Try it (do X, see Y)

```bash
pnpm install
pnpm build            # the web app
pnpm start            # http://localhost:8787 (server + built web app)
```

With no NEAR keys, run `CHAIN=0 pnpm start`: everything plays the same, but nothing is written onchain.

0. **First visit.** Four welcome cards explain the game (Skip or Next). In your first battle a step-by-step walkthrough waits for you to do each thing: move a ship, seal, fire. **? How to play** (or the `?` key) opens the rules, controls and how fairness works, and can replay the tour.
1. **Battle an admiral.** Type a name, pick **Captain Marrow**. You see your waters (left) with a random fleet, and enemy waters (right) under fog. The admiral greets you; with a NEAR AI key the line is marked "✓ signed by NEAR AI TEE".
2. **Place and seal.** Click a ship to pick it up, click a cell for its bow, **R** (or right-click) to turn it, or **Shuffle**. Press **Seal fleet**. The side panel shows "Your seal: <root>…" and an onchain `seal` transaction.
3. **Fire.** Click a cell in the fog. A cannonball arcs over, the fog clears, and you see a splash (miss) or fire (hit). The admiral fires back; your browser answers its shot by itself (it holds your fleet), and the answer is checked against your seal. Sinking a ship shows "You sank their Frigate!".
4. **Win or lose.** At 17 hits both fleets are revealed: the fog lifts and the admiral's ships appear. The panel says the contract rebuilt both seas and found them legal. **Proof (JSON)** opens the full move log with every opening.
5. **Check it yourself**, with no keys and without trusting our server:

   ```
   pnpm verify <gameId> https://fogwater.lopeselio.online
   ✓ both fleet roots match the contract (fogwater.testnet)
   ✓ all 126 answers open the sealed roots (Merkle proofs checked)
   ✓ the replayed shots match the contract’s record
   ✓ seat 1's revealed fleet is legal, matches its root and every “sunk” report
   ✓ seat 2's revealed fleet is legal, matches its root and every “sunk” report
   ✓ winner: seat 2 (fleet sunk); hits 8/17 vs 17/17
   ```
6. **Challenge a friend.** **Create a challenge link**, place and seal your fleet, and send the link (Copy / Share). Your friend opens it, takes the second seat, seals theirs, and you play: live if you're both there, or one move at a time (3 days per move). The tab title shows "● Your move". **Your battles** on the harbour lists every game this browser plays.
7. **Sign in with NEAR** (top right; NEAR Connect: Meteor, Intear, HOT, MyNearWallet, …). The wallet signs "Sign in to <host>" (NEP-413); Better Auth + better-near-auth start a session. Signed-in captains seal their fleet **from their own wallet**, gasless (a NEP-366 meta-transaction paid by `fogwater-relay.testnet`), and are ranked in the **Admirals' ledger** (`leaderboard` on the contract).
8. **Headless:** `pnpm --filter @fogwater/server e2e http://localhost:8787 widow` plays a full game as a browser would and prints every transaction.

## How it works

```
apps/web          three.js voxel sea + React HUD (Vite); NEAR Connect wallet; guests need no wallet
apps/server       games, the admirals, the chain queue (batched `play` calls), WebSocket push, Better Auth, verify + e2e CLIs
packages/rules    board, Merkle seals and openings, turn rules, reveal checks, the admirals' planners (deterministic, isomorphic)
contracts/fleet   Rust near-sdk 5.29: games, seals, answers checked against roots, reveals, timeouts, ledger
```

- **Sealed fleets (privacy).** Every cell of your sea becomes `sha256("fogwater|leaf|<game>|<cell>|<0/1>|<salt>")` with a per-cell salt from your secret seed; the 100 leaves form a Merkle tree and only the root goes onchain. Answering a shot opens one leaf with 7 sibling hashes; the contract refuses any answer that doesn't hash to your root. At the end the contract rebuilds both trees from the revealed seeds: an illegal fleet, a moved ship or a false "sunk" call loses. An all-water sea is caught on the 84th miss.
- **The AI can't cheat.** The admiral's fleet is sealed before your first shot, and it never sees yours: the server only ever receives openings for cells that were shot. Its planner uses its own hits and misses only. The model on NEAR AI only talks; each line is kept with its request, response and the enclave's signature.
- **Chain invisible.** Guests never touch a wallet. The referee batches shots and answers into `play` calls (up to 12 moves each, ~28 transactions and ~0.01 NEAR per game). Signed-in captains approve one gasless transaction per game: sealing their fleet.

### What the chain does *not* prove

- The referee relays everyone's shots, so it could fire a captain's shot at a cell they didn't choose (it can't forge an answer).
- Guest seats are labels the server speaks for; only signed-in captains seal from their own key.
- Your fleet secret lives in this browser's storage. Open a game on another device and it can't answer shots there.

## Tests

```bash
pnpm --filter @fogwater/rules test   # boards, seals/openings, turns, reveals, cheats, admirals
pnpm contract:test                   # 11 contract tests incl. the shared hash vector, lies, moved fleets, empty seas, timeouts
pnpm sim 300                         # admirals' shots-to-win
```

## Deploying

- **Contract:** `pnpm contract:build`, then `near contract deploy fogwater.testnet use-file contracts/fleet/target/near/fogwater_fleet.wasm with-init-call new json-args '{"owner":"fogwater.testnet","referee":"fogwater-ref.testnet"}' …` (later: `without-init-call`).
- **Hosting:** `scripts/deploy-azure.sh` (Azure Container Apps, one replica). `scripts/azure-storage.sh` mounts an Azure Files share at `/data` once, so games survive redeploys.

## Lineage and disclosures

- **Genre.** The grid sea battle is a public-domain classic. The look (a moonlit voxel world, fog of war) and the idea of hidden information enforced by cryptography were inspired by two hackathon games we admired: [Nightfall](https://github.com/codeswithroh/nightfall) and [Who Rug Us?](https://github.com/AiltonSavio/who-rug-us-monorepo), both on Solana/MagicBlock. Fogwater shares no code or assets with them; its privacy comes from Merkle commitments checked by a NEAR contract.
- **Other projects.** Independent of our other NEAR HACKATHON games (Bazaar of Liars, Realm Ledger, Parkwright, Sushi Sabotage); it uses the same sign-in pattern (Better Auth + better-near-auth) and sits beside them in the NEAR Arcade.
- **Libraries:** three.js, React, better-auth and better-near-auth, near-api-js, near-kit, @noble/hashes, ws, Vite, near-sdk (Rust).
- **Assets:** every model is procedural boxes in `apps/web/src/scene.ts`; sounds are synthesised in WebAudio; fonts are Inter and Silkscreen (Google Fonts, OFL).

## License

MIT
