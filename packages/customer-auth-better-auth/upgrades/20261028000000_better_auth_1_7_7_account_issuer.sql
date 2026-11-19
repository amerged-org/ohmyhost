-- Better Auth 1.7.0 through 1.7.2 required account."issuer" and a unique ("issuer", "accountId")
-- index. 1.7.3 and later, including the pinned 1.7.7, write neither and recognise accounts by
-- ("providerId", "accountId"); 1.7.7 refuses every request while a required column it never
-- writes exists. Apply this once as the schema owner to each project database whose auth schema
-- was created before the 1.7.7 pin, before any Worker built with 1.7.7 serves it. It is not an
-- expand-only customer migration (it relaxes a column and drops an index) and is idempotent.
-- The column stays, now nullable, so a Worker still built with 1.7.1 keeps working.
do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'auth' and table_name = 'account' and column_name = 'issuer'
  ) then
    alter table auth."account" alter column "issuer" drop not null;
  end if;
end $$;

drop index if exists auth."account_issuer_accountId_uidx";
