-- Preserve existing rows, including legacy notes and exact signed HTTP bytes.
-- Operators may decline a request; approval comes only from the deployed manifest.
CREATE TRIGGER name_request_evidence_immutable
BEFORE UPDATE OF request_id, owner_pubkey, spark_identity, desired_name, note,
  request_hash, signed_payload, account_proof, wallet_proof, created_at
ON name_requests
BEGIN
  SELECT RAISE(ABORT, 'request evidence is immutable');
END;
