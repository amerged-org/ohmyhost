export function up(pgm) {
  pgm.sql(`
    ALTER TABLE cloudflare_project_authorization_states
      DROP CONSTRAINT cloudflare_project_authorization_states_shape_check;
    ALTER TABLE cloudflare_project_authorization_states
      ADD CONSTRAINT cloudflare_project_authorization_states_shape_check CHECK (
        principal_id=btrim(principal_id) AND length(principal_id) BETWEEN 1 AND 256
        AND zone_name=lower(zone_name) AND length(zone_name)<=253
        AND zone_name~'^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$'
        AND zone_name!~'\\.poc\\.aixyte\\.com$'
        AND octet_length(state_sha256)=32
        AND octet_length(idempotency_key_sha256)=32 AND octet_length(request_sha256)=32
        AND expires_at=issued_at+interval '10 minutes'
        AND (consumed_at IS NULL OR (consumed_at>=issued_at AND consumed_at<expires_at))
      );

    ALTER TABLE cloudflare_project_dns_grants
      DROP CONSTRAINT cloudflare_project_dns_grants_shape_check;
    ALTER TABLE cloudflare_project_dns_grants
      ADD CONSTRAINT cloudflare_project_dns_grants_shape_check CHECK (
        principal_id=btrim(principal_id) AND length(principal_id) BETWEEN 1 AND 256
        AND zone_id~'^[a-f0-9]{32}$'
        AND zone_name=lower(zone_name) AND length(zone_name)<=253
        AND zone_name~'^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$'
        AND zone_name!~'\\.poc\\.aixyte\\.com$'
        AND account_id=btrim(account_id) AND length(account_id) BETWEEN 1 AND 128
        AND scopes=ARRAY['dns.write','zone.read']::text[]
        AND key_version>0 AND access_expires_at>connected_at AND updated_at>=connected_at
        AND ((status='active'
              AND access_expires_at>updated_at
              AND access_ciphertext IS NOT NULL
              AND octet_length(access_ciphertext) BETWEEN 17 AND 65552
              AND access_nonce IS NOT NULL AND octet_length(access_nonce)=12
              AND refresh_ciphertext IS NOT NULL
              AND octet_length(refresh_ciphertext) BETWEEN 17 AND 65552
              AND refresh_nonce IS NOT NULL AND octet_length(refresh_nonce)=12
              AND access_nonce<>refresh_nonce
              AND revoked_at IS NULL)
          OR (status='revoked'
              AND access_ciphertext IS NULL AND access_nonce IS NULL
              AND refresh_ciphertext IS NULL AND refresh_nonce IS NULL
              AND revoked_at IS NOT NULL AND revoked_at>=connected_at
              AND updated_at=revoked_at))
      );
  `);
}

export function down(pgm) {
  pgm.sql(`
    ALTER TABLE cloudflare_project_dns_grants
      DROP CONSTRAINT cloudflare_project_dns_grants_shape_check;
    ALTER TABLE cloudflare_project_dns_grants
      ADD CONSTRAINT cloudflare_project_dns_grants_shape_check CHECK (
        principal_id=btrim(principal_id) AND length(principal_id) BETWEEN 1 AND 256
        AND zone_id~'^[a-f0-9]{32}$' AND zone_name='aixyte.com'
        AND account_id=btrim(account_id) AND length(account_id) BETWEEN 1 AND 128
        AND scopes=ARRAY['dns.write','zone.read']::text[]
        AND key_version>0 AND access_expires_at>connected_at AND updated_at>=connected_at
        AND ((status='active'
              AND access_expires_at>updated_at
              AND access_ciphertext IS NOT NULL
              AND octet_length(access_ciphertext) BETWEEN 17 AND 65552
              AND access_nonce IS NOT NULL AND octet_length(access_nonce)=12
              AND refresh_ciphertext IS NOT NULL
              AND octet_length(refresh_ciphertext) BETWEEN 17 AND 65552
              AND refresh_nonce IS NOT NULL AND octet_length(refresh_nonce)=12
              AND access_nonce<>refresh_nonce
              AND revoked_at IS NULL)
          OR (status='revoked'
              AND access_ciphertext IS NULL AND access_nonce IS NULL
              AND refresh_ciphertext IS NULL AND refresh_nonce IS NULL
              AND revoked_at IS NOT NULL AND revoked_at>=connected_at
              AND updated_at=revoked_at))
      );

    ALTER TABLE cloudflare_project_authorization_states
      DROP CONSTRAINT cloudflare_project_authorization_states_shape_check;
    ALTER TABLE cloudflare_project_authorization_states
      ADD CONSTRAINT cloudflare_project_authorization_states_shape_check CHECK (
        principal_id=btrim(principal_id) AND length(principal_id) BETWEEN 1 AND 256
        AND zone_name='aixyte.com'
        AND octet_length(state_sha256)=32
        AND octet_length(idempotency_key_sha256)=32 AND octet_length(request_sha256)=32
        AND expires_at=issued_at+interval '10 minutes'
        AND (consumed_at IS NULL OR (consumed_at>=issued_at AND consumed_at<expires_at))
      );
  `);
}
