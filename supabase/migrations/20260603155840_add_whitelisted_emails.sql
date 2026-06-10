-- Add whitelisted emails to allowed_emails table.
INSERT INTO allowed_emails (email)
VALUES
  ('hopelko@gmail.com'),
  ('maangeshdkale@gmail.com')
ON CONFLICT (email) DO NOTHING;
