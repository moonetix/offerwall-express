// SQLite storage with node:sqlite, built into Node.js 22. Swap in your own database:
// keep the unique transaction_id and the single transaction around each postback.
import { DatabaseSync } from 'node:sqlite';

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      -- Millionths of a coin. Signed: a reversal of spent coins may go below zero.
      balance_micro INTEGER NOT NULL DEFAULT 0,
      -- Set when the user confirms they are 16 or older. No offerwall link before that.
      age_confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- The rewards ledger: one row per Moonetix transaction_id.
    CREATE TABLE IF NOT EXISTS moonetix_transactions (
      transaction_id TEXT PRIMARY KEY,
      -- The user_id from the postback, as text. Not a foreign key, so a reversal
      -- for an unknown or deleted user can still be recorded.
      wall_user_id TEXT NOT NULL,
      reward_micro INTEGER NOT NULL,
      status INTEGER NOT NULL CHECK (status IN (1, 2)), -- 1 credited, 2 reversed
      offer_name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS moonetix_transactions_user ON moonetix_transactions (wall_user_id);
  `);

  const q = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    insertUser: db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)'),
    confirmAge: db.prepare('UPDATE users SET age_confirmed_at = COALESCE(age_confirmed_at, CURRENT_TIMESTAMP) WHERE id = ?'),
    addBalance: db.prepare('UPDATE users SET balance_micro = balance_micro + ? WHERE id = ?'),
    recent: db.prepare(`SELECT transaction_id, reward_micro, status, offer_name, created_at
      FROM moonetix_transactions WHERE wall_user_id = ? ORDER BY rowid DESC LIMIT 10`),
    insertTx: db.prepare(`INSERT INTO moonetix_transactions (transaction_id, wall_user_id, reward_micro, status, offer_name)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (transaction_id) DO NOTHING`),
    reverseTx: db.prepare(`UPDATE moonetix_transactions SET status = 2, updated_at = CURRENT_TIMESTAMP
      WHERE transaction_id = ? AND status = 1 RETURNING wall_user_id, reward_micro`),
  };

  // BEGIN IMMEDIATE takes the write lock up front, so two copies of one event run one after the other.
  function inTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // The user_id in the link is our users.id. Anything else (for example test_user) is not ours.
  function findUser(userId) {
    if (!/^[1-9][0-9]{0,14}$/.test(userId)) return null;
    return q.userById.get(Number(userId)) ?? null;
  }

  return {
    db,
    inTransaction,
    findUserById: (id) => q.userById.get(id) ?? null,
    findUserByName: (name) => q.userByName.get(name) ?? null,
    createUser: (username, passwordHash) => Number(q.insertUser.run(username, passwordHash).lastInsertRowid),
    confirmAge: (id) => q.confirmAge.run(id),
    recent: (id) => q.recent.all(String(id)),

    // Applies one verified postback. Returns what happened, as a short sentence.
    applyPostback({ tx, userId, rewardMicro, status, offer }) {
      return inTransaction(() => {
        if (status === 1) {
          const user = findUser(userId);
          if (!user) return 'Unknown user, nothing credited';
          // The primary key decides: only the first insert credits.
          const ins = q.insertTx.run(tx, userId, rewardMicro, 1, offer || null);
          if (ins.changes !== 1) return 'Already processed';
          q.addBalance.run(rewardMicro, user.id);
          return 'Credited';
        }
        // Flips 1 to 2 at most once, and returns what was credited and to whom.
        const row = q.reverseTx.get(tx);
        if (row) {
          const user = findUser(row.wall_user_id);
          if (user) q.addBalance.run(-row.reward_micro, user.id);
          return 'Reversed';
        }
        // Never credited: remember it, so a late credit for this transaction is never paid.
        const ins = q.insertTx.run(tx, userId, rewardMicro, 2, offer || null);
        return ins.changes === 1 ? 'Not credited before, nothing taken back' : 'Already processed';
      });
    },

    close: () => db.close(),
  };
}
