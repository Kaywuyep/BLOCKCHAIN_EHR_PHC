add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' $oidc_origin; form-action 'self' $oidc_origin; frame-ancestors 'none'; base-uri 'self'; object-src 'none'" always;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), display-capture=()" always;
  add_header Cross-Origin-Opener-Policy "same-origin" always;
