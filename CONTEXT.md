# Market Sniper

Market Sniper is a multi-user trading alert dashboard for surfacing institutional-style liquidity trap setups and tracking paper trades against live market prices.

## Language

**Market Sniper User**:
An authenticated person using the dashboard to view alerts and manage their own paper trades.
_Avoid_: account, customer

**Instrument**:
A tradeable listed security tracked by Market Sniper.
_Avoid_: stock when referring to stored identity

**Liquidity Trap Alert**:
A system-generated signal that an Instrument has swept an important liquidity level with confirming market context.
_Avoid_: signal, notification

**Conviction Score**:
A 0-100 score expressing how strongly the alert context supports the Liquidity Trap Alert.
_Avoid_: confidence score, probability

**Score Factor**:
A named component that contributes to the Conviction Score.
_Avoid_: indicator, metric when referring to score composition

**Shadow Trade**:
A user-owned paper position opened from a Liquidity Trap Alert without placing a broker order.
_Avoid_: paper order, real trade

**Price Mark**:
A stored latest price observation used to value open Shadow Trades.
_Avoid_: tick when the source is not guaranteed tick-level

## Relationships

- A **Liquidity Trap Alert** belongs to exactly one **Instrument**.
- A **Liquidity Trap Alert** has one **Conviction Score** and zero or more **Score Factors**.
- A **Market Sniper User** can create many **Shadow Trades**.
- A **Shadow Trade** belongs to exactly one **Market Sniper User** and one **Instrument**.
- A **Shadow Trade** may be opened from one **Liquidity Trap Alert**.
- A **Price Mark** belongs to exactly one **Instrument**.

## Example dialogue

> **Dev:** "When a Market Sniper User clicks Paper Trade on a Liquidity Trap Alert, do we create a real broker order?"
> **Domain expert:** "No. We create a Shadow Trade tied to the user and alert, then value it using Price Marks."

## Flagged ambiguities

- "Confidence" is resolved to **Conviction Score** because the score expresses setup quality, not a statistical probability.
- "Paper trade" is resolved to **Shadow Trade** because the product tracks virtual positions, not broker orders.
