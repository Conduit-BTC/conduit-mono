CREATE TABLE name_requests (
  request_id TEXT PRIMARY KEY,
  owner_pubkey TEXT NOT NULL,
  spark_identity TEXT NOT NULL,
  desired_name TEXT NOT NULL,
  note TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  signed_payload TEXT NOT NULL,
  account_proof TEXT NOT NULL,
  wallet_proof TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'declined'))
);
CREATE INDEX requests_review ON name_requests(status, created_at);
CREATE TABLE mutation_claims (
  statement_hash TEXT PRIMARY KEY,
  identity TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE address_observations (
  identity TEXT PRIMARY KEY,
  name TEXT,
  observed_at INTEGER NOT NULL
);
