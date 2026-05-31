CREATE TABLE option_strategy_overrides (
  id           TEXT PRIMARY KEY NOT NULL,
  account_id   TEXT NOT NULL,
  underlying   TEXT NOT NULL,
  name         TEXT,
  strategy_type TEXT,
  legs         TEXT NOT NULL,    -- JSON 数组
  mode         TEXT NOT NULL,    -- 'group' | 'exclude'
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_option_strategy_overrides_account ON option_strategy_overrides(account_id);
