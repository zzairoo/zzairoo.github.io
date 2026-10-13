create extension if not exists pgcrypto;

create table if not exists public.rooms (
  slug text primary key,
  password_hash text not null,
  data jsonb not null default '{"players": [], "matches": [], "settlements": []}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.rooms add column if not exists data jsonb not null default '{"players": [], "matches": [], "settlements": []}'::jsonb;
alter table public.rooms add column if not exists admin_hash text;
alter table public.rooms add column if not exists created_at timestamptz not null default now();
alter table public.rooms add column if not exists updated_at timestamptz not null default now();

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  room_slug text not null references public.rooms(slug) on delete cascade,
  name text not null,
  iban text not null default '',
  account_name text not null default '',
  pin_hash text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  room_slug text not null references public.rooms(slug) on delete cascade,
  stake numeric(12, 2) not null check (stake > 0),
  winner_ids uuid[] not null default '{}',
  loser_ids uuid[] not null default '{}',
  receive_from_by_winner jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.settlements (
  id uuid primary key default gen_random_uuid(),
  room_slug text not null references public.rooms(slug) on delete cascade,
  from_player_id uuid not null references public.players(id),
  to_player_id uuid not null references public.players(id),
  amount numeric(12, 2) not null check (amount > 0),
  status text not null check (status in ('marked_paid', 'confirmed_received')),
  marked_by_player_id uuid references public.players(id),
  confirmed_by_player_id uuid references public.players(id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists players_room_slug_idx on public.players(room_slug) where deleted_at is null;
create index if not exists matches_room_slug_idx on public.matches(room_slug) where deleted_at is null;
create index if not exists settlements_room_slug_idx on public.settlements(room_slug);

delete from public.settlements s
using public.settlements newer
where s.status = 'marked_paid'
  and newer.status = 'marked_paid'
  and s.room_slug = newer.room_slug
  and s.from_player_id = newer.from_player_id
  and s.to_player_id = newer.to_player_id
  and (newer.created_at, newer.id) > (s.created_at, s.id);

create unique index if not exists settlements_pending_pair_idx on public.settlements(room_slug, from_player_id, to_player_id) where status = 'marked_paid';

insert into public.players (id, room_slug, name)
select (player->>'id')::uuid, rooms.slug, player->>'name'
from public.rooms
cross join lateral jsonb_array_elements(coalesce(rooms.data->'players', '[]'::jsonb)) as player
where player ? 'id'
on conflict (id) do nothing;

insert into public.matches (id, room_slug, stake, winner_ids, loser_ids, receive_from_by_winner, created_at)
select
  (match->>'id')::uuid,
  rooms.slug,
  (match->>'stake')::numeric,
  coalesce(array(select jsonb_array_elements_text(match->'winnerIds')::uuid), '{}'),
  coalesce(array(select jsonb_array_elements_text(match->'loserIds')::uuid), '{}'),
  coalesce(match->'receiveFromByWinner', '{}'::jsonb),
  to_timestamp(((match->>'createdAt')::numeric / 1000.0))
from public.rooms
cross join lateral jsonb_array_elements(coalesce(rooms.data->'matches', '[]'::jsonb)) as match
where match ? 'id'
on conflict (id) do nothing;

alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.matches enable row level security;
alter table public.settlements enable row level security;

revoke all on public.rooms from anon, authenticated;
revoke all on public.players from anon, authenticated;
revoke all on public.matches from anon, authenticated;
revoke all on public.settlements from anon, authenticated;

drop function if exists public.save_room_data(text, text, jsonb);
drop function if exists public.upsert_player(text, text, uuid, text, text, text, text);
drop function if exists public.delete_player(text, text, uuid);
drop function if exists public.delete_match_result(text, text, uuid);
drop function if exists public.add_match_result(text, text, numeric, uuid[], uuid[], jsonb);
drop function if exists public.cancel_settlement_paid(text, text, uuid);
drop function if exists public.confirm_settlement_received(text, text, uuid, uuid);
drop function if exists public.reset_leaderboard(text, text, text);

create or replace function public.room_state(p_slug text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'iban', p.iban,
        'accountName', p.account_name
      ) order by lower(p.name))
      from public.players p
      where p.room_slug = p_slug and p.deleted_at is null
    ), '[]'::jsonb),
    'matches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'createdAt', floor(extract(epoch from m.created_at) * 1000),
        'stake', m.stake,
        'winnerIds', to_jsonb(m.winner_ids),
        'loserIds', to_jsonb(m.loser_ids),
        'receiveFromByWinner', m.receive_from_by_winner
      ) order by m.created_at desc)
      from public.matches m
      where m.room_slug = p_slug and m.deleted_at is null
    ), '[]'::jsonb),
    'settlements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'from', s.from_player_id,
        'to', s.to_player_id,
        'amount', s.amount,
        'status', s.status,
        'markedBy', s.marked_by_player_id,
        'createdAt', floor(extract(epoch from s.created_at) * 1000),
        'confirmedBy', s.confirmed_by_player_id,
        'confirmedAt', case when s.confirmed_at is null then null else floor(extract(epoch from s.confirmed_at) * 1000) end
      ) order by s.created_at desc)
      from public.settlements s
      where s.room_slug = p_slug
    ), '[]'::jsonb)
  )
  from public.rooms r
  where r.slug = p_slug;
$$;

create or replace function public.join_room(p_slug text, p_password_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_room public.rooms%rowtype;
begin
  select * into existing_room from public.rooms where slug = p_slug;

  if not found then
    insert into public.rooms (slug, password_hash)
    values (p_slug, p_password_hash)
    returning * into existing_room;
  elsif existing_room.password_hash <> p_password_hash then
    raise exception 'Wrong room password';
  end if;

  return public.room_state(p_slug);
end;
$$;

create or replace function public.login_player(p_slug text, p_password_hash text, p_player_id uuid, p_pin_hash text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  stored_hash text;
begin
  perform 1 from public.rooms where slug = p_slug and password_hash = p_password_hash;
  if not found then raise exception 'Room not found or wrong password'; end if;

  select pin_hash into stored_hash
  from public.players
  where id = p_player_id and room_slug = p_slug and deleted_at is null;

  return stored_hash is not null and stored_hash = p_pin_hash;
end;
$$;

create or replace function public.ensure_admin(p_slug text, p_password_hash text, p_admin_hash text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_admin_hash text;
begin
  select admin_hash into current_admin_hash
  from public.rooms
  where slug = p_slug and password_hash = p_password_hash;

  if not found then raise exception 'Room not found or wrong password'; end if;
  if nullif(p_admin_hash, '') is null then raise exception 'Admin code required'; end if;

  if current_admin_hash is null then
    update public.rooms set admin_hash = p_admin_hash, updated_at = now() where slug = p_slug;
  elsif current_admin_hash <> p_admin_hash then
    raise exception 'Wrong admin code';
  end if;
end;
$$;

create or replace function public.upsert_player(p_slug text, p_password_hash text, p_admin_hash text, p_player_id uuid, p_name text, p_iban text, p_account_name text, p_pin_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  next_id uuid := coalesce(p_player_id, gen_random_uuid());
begin
  perform public.ensure_admin(p_slug, p_password_hash, p_admin_hash);

  insert into public.players (id, room_slug, name, iban, account_name, pin_hash)
  values (next_id, p_slug, nullif(trim(p_name), ''), trim(coalesce(p_iban, '')), trim(coalesce(p_account_name, '')), p_pin_hash)
  on conflict (id) do update
  set name = excluded.name,
      iban = excluded.iban,
      account_name = excluded.account_name,
      pin_hash = coalesce(excluded.pin_hash, public.players.pin_hash),
      deleted_at = null,
      updated_at = now();

  return public.room_state(p_slug);
end;
$$;

create or replace function public.delete_player(p_slug text, p_password_hash text, p_admin_hash text, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_admin(p_slug, p_password_hash, p_admin_hash);

  update public.players set deleted_at = now(), updated_at = now()
  where id = p_player_id and room_slug = p_slug;

  return public.room_state(p_slug);
end;
$$;

create or replace function public.add_match_result(p_slug text, p_password_hash text, p_match_id uuid, p_stake numeric, p_winner_ids uuid[], p_loser_ids uuid[], p_receive_from_by_winner jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.rooms where slug = p_slug and password_hash = p_password_hash;
  if not found then raise exception 'Room not found or wrong password'; end if;

  insert into public.matches (id, room_slug, stake, winner_ids, loser_ids, receive_from_by_winner)
  values (p_match_id, p_slug, p_stake, p_winner_ids, p_loser_ids, coalesce(p_receive_from_by_winner, '{}'::jsonb))
  on conflict (id) do update
  set stake = excluded.stake,
      winner_ids = excluded.winner_ids,
      loser_ids = excluded.loser_ids,
      receive_from_by_winner = excluded.receive_from_by_winner,
      deleted_at = null;

  return public.room_state(p_slug);
end;
$$;

create or replace function public.delete_match_result(p_slug text, p_password_hash text, p_admin_hash text, p_match_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_admin(p_slug, p_password_hash, p_admin_hash);

  update public.matches set deleted_at = now()
  where id = p_match_id and room_slug = p_slug;

  return public.room_state(p_slug);
end;
$$;

create or replace function public.mark_settlement_paid(p_slug text, p_password_hash text, p_from_player_id uuid, p_to_player_id uuid, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.rooms where slug = p_slug and password_hash = p_password_hash;
  if not found then raise exception 'Room not found or wrong password'; end if;

  if p_from_player_id = p_to_player_id then raise exception 'Cannot mark a payment to yourself'; end if;

  insert into public.settlements (room_slug, from_player_id, to_player_id, amount, status, marked_by_player_id)
  values (p_slug, p_from_player_id, p_to_player_id, p_amount, 'marked_paid', p_from_player_id)
  on conflict (room_slug, from_player_id, to_player_id) where status = 'marked_paid'
  do update set amount = excluded.amount,
                marked_by_player_id = excluded.marked_by_player_id,
                created_at = now();

  return public.room_state(p_slug);
end;
$$;

create or replace function public.cancel_settlement_paid(p_slug text, p_password_hash text, p_settlement_id uuid, p_actor_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  settlement_record public.settlements%rowtype;
begin
  perform 1 from public.rooms where slug = p_slug and password_hash = p_password_hash;
  if not found then raise exception 'Room not found or wrong password'; end if;

  select * into settlement_record
  from public.settlements
  where id = p_settlement_id and room_slug = p_slug and status = 'marked_paid';

  if not found then raise exception 'Pending payment not found'; end if;
  if p_actor_player_id <> settlement_record.from_player_id then raise exception 'Only the payer can mark this payment unpaid'; end if;

  delete from public.settlements
  where id = p_settlement_id;

  return public.room_state(p_slug);
end;
$$;

create or replace function public.confirm_settlement_received(p_slug text, p_password_hash text, p_admin_hash text, p_settlement_id uuid, p_confirmer_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  settlement_record public.settlements%rowtype;
begin
  perform 1 from public.rooms where slug = p_slug and password_hash = p_password_hash;
  if not found then raise exception 'Room not found or wrong password'; end if;

  select * into settlement_record
  from public.settlements
  where id = p_settlement_id and room_slug = p_slug;

  if not found then raise exception 'Settlement not found'; end if;
  if p_confirmer_player_id = settlement_record.from_player_id then raise exception 'Payer cannot confirm their own payment'; end if;
  if p_confirmer_player_id is null then
    perform public.ensure_admin(p_slug, p_password_hash, p_admin_hash);
  elsif p_confirmer_player_id <> settlement_record.to_player_id then
    raise exception 'Only the receiver can confirm this payment';
  end if;

  update public.settlements
  set status = 'confirmed_received',
      confirmed_by_player_id = p_confirmer_player_id,
      confirmed_at = now()
  where id = p_settlement_id and room_slug = p_slug;

  return public.room_state(p_slug);
end;
$$;

create or replace function public.reset_leaderboard(p_slug text, p_password_hash text, p_admin_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_admin(p_slug, p_password_hash, p_admin_hash);

  delete from public.settlements
  where room_slug = p_slug and status = 'confirmed_received';

  return public.room_state(p_slug);
end;
$$;

grant execute on function public.room_state(text) to anon, authenticated;
grant execute on function public.join_room(text, text) to anon, authenticated;
grant execute on function public.login_player(text, text, uuid, text) to anon, authenticated;
grant execute on function public.ensure_admin(text, text, text) to anon, authenticated;
grant execute on function public.upsert_player(text, text, text, uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.delete_player(text, text, text, uuid) to anon, authenticated;
grant execute on function public.add_match_result(text, text, uuid, numeric, uuid[], uuid[], jsonb) to anon, authenticated;
grant execute on function public.delete_match_result(text, text, text, uuid) to anon, authenticated;
grant execute on function public.mark_settlement_paid(text, text, uuid, uuid, numeric) to anon, authenticated;
grant execute on function public.cancel_settlement_paid(text, text, uuid, uuid) to anon, authenticated;
grant execute on function public.confirm_settlement_received(text, text, text, uuid, uuid) to anon, authenticated;
grant execute on function public.reset_leaderboard(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
