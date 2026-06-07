# Example bank-statement CSVs

Synthetic fixtures used to develop and test `import_transactions`. They cover
the format variations a real importer must handle. Each maps to an **import
profile** (a column mapping + sign convention); the goal is that a few profiles
plus an override cover most banks.

| File | Shape | Date format | Amount convention | Notes |
|------|-------|-------------|-------------------|-------|
| `chase-checking.csv` | `Details, Posting Date, Description, Amount, Type, Balance` | `MM/DD/YYYY` | single signed `Amount` (− = money out) | extra `Details`/`Type`/`Balance` columns to ignore |
| `amex-card.csv` | `Date, Description, Amount` | `MM/DD/YYYY` | card: **+ = charge** (spend), − = payment | sign is inverted vs. a bank account |
| `generic-debit-credit.csv` | `Date, Description, Debit, Credit, Balance` | `YYYY-MM-DD` | split columns: `Debit` = out, `Credit` = in | refund appears in `Credit` |
| `simple.csv` | `Date, Description, Amount` | `YYYY-MM-DD` | single signed `Amount` | smallest possible shape |

## What the importer must normalize

- **Column mapping** — which columns are date / description / amount (or debit+credit).
- **Date parsing** — `MM/DD/YYYY` and `YYYY-MM-DD` (at least).
- **Sign convention** — bank-signed, card-signed (inverted), or split debit/credit → one signed minor-unit amount.
- **Direction → accounts** — money-out maps to `from: <this account> → to: <expense/category>`; money-in maps to `from: <income> → to: <this account>`. The destination category is filled by the categorization rules (or left `Uncategorized`).
- **Dedup** — repeated imports must not double-post. Uses `JournalEntry.externalId` when the bank supplies an id; otherwise a hash of `(account, date, amount, description)`.

These fixtures are fake data — safe to commit and to import into a dev branch.
