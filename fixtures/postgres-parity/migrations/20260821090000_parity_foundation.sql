create table public.parity_accounts(
  id bigint generated always as identity primary key,
  display_name text
);

create index parity_accounts_display_name_idx on public.parity_accounts(display_name);
