# CRL 6 Mans Queue Bot — Test Plan

A straightforward guide to verify the bot works correctly with real players. Run through these scenarios in order; each builds on the previous setup.

## Prerequisites

- Bot is deployed and configured in your Discord server
- Required channels are set via `/setqueuechannel` and `/setreportchannel`
- 6+ real players available to test
- At least one admin user has access to `/admin` commands

---

## Phase 1: Queue Basics

### 1.1 Join/Leave Queue

**Players:** 2

1. Player A runs `/q` in #rank-queue
   - ✓ Ephemeral reply: "Added to Rank Queue (1/6)"
   - ✓ Queue status message appears showing "1. Player A"

2. Player B runs `/q`
   - ✓ Queue shows "1. Player A, 2. Player B"

3. Player A runs `/l`
   - ✓ Queue shows "1. Player B" (Player A removed)
   - ✓ Ephemeral reply to Player A

4. Player A re-joins with `/queue`
   - ✓ Back at position 2
   - ✓ Alias `/queue` works (same as `/q`)

---

### 1.2 Cross-Queue Auto-Remove

**Players:** 4

1. Players A and B join #rank-queue (2/6)
2. Players C and D join #universal-queue (2/6)
3. Player A runs `/q` in #universal-queue
   - ✓ Joins universal-queue (now 3/6)
   - ✓ Stays in rank-queue (both queues show the player)

4. Meanwhile, fill up rank-queue to 6/6 with new players → **POP**
   - ✓ Rank Queue pops
   - ✓ Player A is auto-removed from universal-queue
   - ✓ Universal-queue updates to show Player A missing
   - ✓ Rank-queue series created with 6 players

---

## Phase 2: Team Formation

### 2.1 Voting — Balanced Mode Wins

**Players:** 6 (from a pop)

1. Queue pops → vote message appears with 2 buttons: Balanced / Captains
2. Player 1 clicks Balanced
   - ✓ Vote tally updates (Balanced 1/3)
3. Player 2 clicks Balanced
   - ✓ Tally → Balanced 2/3
4. Player 3 clicks Balanced
   - ✓ **Balanced mode wins** (3/3)
   - ✓ Vote message is deleted
   - ✓ "Teams Formed" message appears showing 3v3 split with MMR averages
   - ✓ Two voice channels created (Team A, Team B)
   - ✓ Players see their team assignment

---

### 2.2 Voting — Captains Mode Wins

**Players:** 6 (new pop)

1. Vote message appears
2. Players 1, 2, 3 click Captains (3/3)
   - ✓ Captains mode begins immediately
   - ✓ Top 2 MMR players become captains (show in message)

3. Captain 1 receives DM with pick buttons
   - ✓ "Pick one player from: [A], [B], [C], [D]"
   - ✓ Clicks a button
   - ✓ Caption 2 receives DM
   - ✓ "Pick two players from: [remaining]"

4. Captain 2 picks twice (two buttons)
   - ✓ After 2nd pick, last player auto-assigns
   - ✓ "Teams Formed" message shows final 3v3
   - ✓ Voice channels created

---

### 2.3 Vote Timeout

**Players:** 6 (new pop)

1. Vote message appears
2. **Wait 3+ minutes without anyone voting**
   - ✓ Series cancelled (no pop, no match)
   - ✓ "Series timed out (vote silence)" message in queue channel
   - ✓ All 6 players unlocked to queue again
   - ✓ Voice channels deleted

---

## Phase 3: Reporting & MMR

### 3.1 Report a Win

**Players:** 6 (in active series after team formation)

1. Player on Team A runs `/report result:win`
   - ✓ Ephemeral reply deleted (no feedback)
   - ✓ Report embed posted to #report-channel
   - ✓ Shows **Winners** (Team A players) with MMR deltas, **Losers** (Team B) with deltas
   - ✓ Each line shows: Player Name, Δ MMR, New MMR, Band

2. Check leaderboard
   - ✓ Team A players' MMR increased
   - ✓ Team B players' MMR decreased
   - ✓ All 6 players' games-played counts incremented

3. All 6 players can queue again
   - ✓ No "locked in series" errors

---

### 3.2 Report from Anywhere

**Players:** 6 (new series, mid-match)

1. Player from Team A runs `/report result:win` in **any channel** (e.g., #general)
   - ✓ Works (no channel restriction)
   - ✓ Series inferred from player's active lock
   - ✓ Report processed normally

2. Player from Team B runs `/r result:loss` (alias)
   - ✓ Alias `/r` works the same as `/report`

---

### 3.3 Provisional K-Factor

**Setup:** Player C has < 10 total games on Rank Queue; others have 10+

**Players:** 6 (series with mixed provisional status)

1. Report a match (Team A wins)
2. Check report embed MMR deltas
   - ✓ Player C's delta is ~1.75x larger than a 10+ game player in same position
   - ✓ Other players' deltas are standard K=32

---

## Phase 4: Bands & Placement

### 4.1 Placement Bootstrap

**Setup:** Fresh player with 0 games

1. New player joins Rank Queue and plays 9 games (all wins or mixed)
   - ✓ Leaderboard shows "NA" band and "NA" MMR (not placed yet)
   - ✓ No "Placed" role assigned

2. Player plays 10th game
   - ✓ Game is reported normally
   - ✓ Next daily cron tick (within 24h)
   - ✓ Player gets assigned a band based on MMR percentile
   - ✓ Leaderboard now shows real band + MMR
   - ✓ Player receives DM about band assignment
   - ✓ "Placed" role granted

---

### 4.2 Band Promotion

**Setup:** Iron-ranked player steadily wins games

1. Player accumulates MMR wins over several matches
2. **Next daily band recompute** (admin can trigger `/admin recompute-bands`)
   - ✓ If now in Garnet percentile range (40–70th), promoted to Garnet
   - ✓ Old Iron role removed, Garnet role granted
   - ✓ DM: "Promoted to Garnet"

---

### 4.3 Band Demotion (with Grace Period)

**Setup:** Garnet player (just promoted)

1. Player just entered Garnet from Iron; `band_games_played` = 0
2. Player loses 3 games in a row → MMR drops below Garnet threshold
3. **Next daily recompute**
   - ✓ **NOT demoted** (grace period: 3 games played in band)
   - ✓ Message: "Still in grace period"

4. Player plays 2 more games (total 5 in Garnet)
5. **Next daily recompute** with still-low MMR
   - ✓ Grace expired (3 games min)
   - ✓ Check hysteresis: only demote if >5% below promotion threshold
   - ✓ If qualifies, demoted to Iron
   - ✓ DM: "Demoted to Iron"

---

## Phase 5: Admin Commands

### 5.1 Admin Config Get/Set

**Admin:** Run these commands

1. `/admin config get` (no key)
   - ✓ Lists all config values with current DB value or default
   - ✓ Marks defaults with "(default)" tag

2. `/admin config get key:k_factor`
   - ✓ Shows "k_factor = 32" (or custom value)

3. `/admin config set key:k_factor value:40`
   - ✓ Config updated
   - ✓ `/admin config get key:k_factor` shows "40"

4. Reset it back: `/admin config set key:k_factor value:32`

---

### 5.2 Admin Unreport

**Setup:** Match reported with series ID (e.g., abc-123)

1. `/admin unreport id:abc-123`
   - ✓ Series status flipped from "reported" to "void"
   - ✓ All 6 players' MMR unwound (reverted)
   - ✓ games_played counters decremented
   - ✓ Report channel embed removed (replaced with "Unreported" message)
   - ✓ Audit log entry created

---

### 5.3 Admin Correct-Report

**Setup:** Match reported with Team A as winner, but Team B actually won (series ID: xyz-789)

1. `/admin correct-report id:xyz-789 winner:team_b`
   - ✓ Series status stays "reported"
   - ✓ Old MMR deltas reversed
   - ✓ New MMR deltas applied (Team B now gets +, Team A gets -)
   - ✓ Report embed updated with new winner
   - ✓ Audit log entry: "correct-report"

---

### 5.4 Admin Adjust-MMR

**Setup:** Player needs manual MMR adjustment (e.g., Player X currently at 1000 MMR)

1. `/admin adjust-mmr target:@PlayerX delta:-50`
   - ✓ Player X MMR: 1000 → 950
   - ✓ Leaderboard updates immediately

2. Later: `/admin adjust-mmr target:@PlayerX mmr:1000` (absolute set)
   - ✓ Player X MMR set to exactly 1000
   - ✓ Audit log shows both adjustments

---

### 5.5 Admin Force-Leave

**Setup:** Player stuck in queue or series (e.g., unresponsive)

1. `/admin force-leave target:@StuckPlayer`
   - ✓ If in queue: removed, queue updates
   - ✓ If in series: series voided, all 6 unlocked
   - ✓ Audit log entry

---

## Phase 6: Substitutes

### 6.1 Sub Accept (Happy Path)

**Setup:** Series in progress (Team A: Players 1, 2, 3; Team B: Players 4, 5, 6)

1. Player 1 (Team A) runs `/sub nominee:@Player7`
   - ✓ Player 7 receives a button DM: "Accept sub?"
   - ✓ Sub request appears in DB

2. Player 7 clicks Accept
   - ✓ Player 7 added to series_players (Team A)
   - ✓ Player 1 removed from series_players
   - ✓ Player 7 auto-removed from any queue they were in
   - ✓ DM reply: "Sub accepted"
   - ✓ Series can now report normally

---

### 6.2 Sub Timeout

**Setup:** Active sub request (Player 1 nominated Player 7)

1. **Wait 10+ minutes** without Player 7 responding
   - ✓ Sub request expires
   - ✓ Status message in queue channel updates to "Sub request expired"
   - ✓ Player 1 free to `/sub` again with someone else
   - ✓ Player 7 still free to queue

---

## Phase 7: Mid-Series Abandonment

### 7.1 Abandon Vote Threshold

**Setup:** Series locked in (6 players, no report yet)

1. Player 6 is AFK / unresponsive
2. Player 1 runs `/abandon target:@Player6`
   - ✓ Vote recorded (1/3 needed)
   - ✓ Private feedback: "Vote recorded (1/3)"

3. Player 2 runs `/abandon target:@Player6`
   - ✓ Vote count → 2/3
   - ✓ Private feedback: "Vote recorded (2/3)"

4. Player 3 runs `/abandon target:@Player6`
   - ✓ **3/3 threshold met**
   - ✓ Series immediately cancelled (status: void)
   - ✓ Other 5 players unlocked to queue
   - ✓ "Series cancelled — Player 6 abandoned" message in queue channel
   - ✓ Voice channels deleted

---

### 7.2 Abandon Self-Target Blocked

1. Player tries `/abandon target:@themselves`
   - ✓ Rejected: "You can't report yourself"

---

## Phase 8: Seasons

### 8.1 Season Close & Soft Reset

**Setup:** Season 1 is active with 6+ players who have played games

1. Admin runs `/newseason`
   - ✓ Season 1 marked inactive
   - ✓ season_history rows created (rankings, Top 10 flags)
   - ✓ Prism role assigned to Top 10 players (if 8+ games)
   - ✓ MMR soft-reset applied to all placed players
   - ✓ Season 2 created and marked active
   - ✓ Leaderboard shows "Season 2" header

2. Check a player's MMR before/after
   - ✓ Pre-decay: 500 MMR → Post-decay: ~375 (approximately 75% of original)
   - ✓ Formula: `new = (old * median) / (median + 0.25 * old)`

3. Check player who was Top 10
   - ✓ "Prism" role granted
   - ✓ Leaderboard shows Prism indicator (white gradient)

---

## Phase 9: Edge Cases & Error Handling

### 9.1 Series Timeout (2+ hours)

**Setup:** Series formed but never reported

1. Create a series and let it sit for 2+ hours
   - ✓ Sweep runs every minute
   - ✓ **At 2-hour mark:** series auto-voided
   - ✓ Report channel: "Series timed out — no MMR change"
   - ✓ All 6 players unlocked
   - ✓ Voice channels deleted

---

### 9.2 Queue Member Timeout (30 minutes)

**Setup:** Player joins queue but series never pops

1. Player joins at 12:00 PM
2. **At 12:30 PM** (30 min later, no pop)
   - ✓ Player auto-removed from queue
   - ✓ DM: "You've been auto-removed from Rank Queue after 30 minutes without a match"
   - ✓ Queue status message updates (player count shrinks)
   - ✓ Orange embed in queue channel: "@Player has been removed from the queue because of inactivity"

---

### 9.3 Concurrent Report Race (Both Teams Report)

**Setup:** Series in progress, both teams report simultaneously

1. Player 1 (Team A) runs `/report result:win`
2. Player 4 (Team B) runs `/report result:loss` at same time
   - ✓ **First one succeeds**, series settled
   - ✓ **Second one fails:** "That series isn't in an active state" or "already reported"
   - ✓ No double-counting, no weird state

---

### 9.4 Player Already in Series Tries to Queue

**Setup:** Player locked in active series

1. Player 1 runs `/q` in #universal-queue
   - ✓ Rejected: "You're already locked into an active series — finish or report that first"

---

## Phase 10: Notifications & Messaging

### 10.1 DM on Band Change

**Setup:** Player just promoted to new band

1. Check DMs from the bot
   - ✓ DM received: "Promoted to [Band Name]"
   - ✓ Timing: within ~24h of daily recompute

---

### 10.2 Queue Message Stays Current

**Setup:** Queue has active member list

1. Watch the queue status message
   - ✓ Message is always the most recent in the channel
   - ✓ When someone joins/leaves, old message deleted, new one posted
   - ✓ Never multiple queue messages visible at once

---

## Final Checklist

- [ ] **Queue system** works (join, leave, cross-queue)
- [ ] **Team formation** works (Balanced & Captains modes, voting)
- [ ] **Reporting** works (MMR applied, leaderboard updates)
- [ ] **Bands** work (placement, promotion, demotion with grace/hysteresis)
- [ ] **Seasons** work (close, soft reset, Top 10 / Prism)
- [ ] **Admin commands** work (config, unreport, correct-report, adjust-mmr)
- [ ] **Substitutes** work (accept, timeout)
- [ ] **Abandonment** works (3-vote threshold)
- [ ] **Timeouts** work (series, queue member, sub request)
- [ ] **DMs** are received correctly (promotions, team assignments, auto-remove)
- [ ] **Audit log** tracks all admin actions
- [ ] **Error messages** are clear when things fail

---

## Notes

- If you hit an error or unexpected behavior, check `/admin audit-log` to see what was attempted
- Use `/admin config get` to verify timeout values match expectations (defaults: series 2h, queue member 30m, sub request 10m)
- Leaderboard updates are near-instant for reporting; band changes are once daily (~9 AM UTC by default)
- Test with real Discord accounts to catch permission / role sync issues early
