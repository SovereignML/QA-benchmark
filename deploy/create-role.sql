-- Least-privilege Postgres role for AutoSignUp on the prod server.
--
-- Run once as the postgres superuser, in the app database:
--   sudo -u postgres psql -d sovereignml -v pw="'<a strong password>'" -f deploy/create-role.sql
--
-- AutoSignUp can then create and delete test users and nothing else. Deleting
-- a User still cascades to its Team/Membership/etc.: Postgres runs foreign-key
-- actions with the referencing table owner's rights, not this role's.

CREATE ROLE autosignup LOGIN PASSWORD :pw;

GRANT CONNECT ON DATABASE sovereignml TO autosignup;
GRANT USAGE ON SCHEMA public TO autosignup;

-- What a signup, a verification and a cleanup write.
GRANT SELECT, INSERT, UPDATE, DELETE ON "User" TO autosignup;
GRANT SELECT, INSERT                 ON "Team", "Membership" TO autosignup;
GRANT SELECT, INSERT, DELETE         ON "VerificationToken" TO autosignup;

-- Read-only: schema fingerprint + cleanup safety checks.
GRANT SELECT ON "Instance", "ByosServer", "Subscription", "Wallet", "RateLimitBucket" TO autosignup;
