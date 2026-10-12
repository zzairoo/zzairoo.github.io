create table if not exists public.rooms (
  slug text primary key,
  password_hash text not null,
  data jsonb not null default '{"players": [], "matches": []}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.rooms enable row level security;

revoke all on public.rooms from anon, authenticated;

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

  return existing_room.data;
end;
$$;

create or replace function public.save_room_data(p_slug text, p_password_hash text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.rooms
  set data = jsonb_build_object(
        'players', coalesce((
          select jsonb_agg(player order by lower(player->>'name'))
          from (
            select distinct on (id) id, player
            from (
              select item->>'id' as id, item as player, 1 as priority
              from jsonb_array_elements(coalesce(public.rooms.data->'players', '[]'::jsonb)) as item
              union all
              select item->>'id' as id, item as player, 2 as priority
              from jsonb_array_elements(coalesce(p_data->'players', '[]'::jsonb)) as item
            ) merged_players
            where id is not null
              and not (id in (
                select jsonb_array_elements_text(coalesce(public.rooms.data->'deletedPlayerIds', '[]'::jsonb) || coalesce(p_data->'deletedPlayerIds', '[]'::jsonb))
              ))
            order by id, priority desc
          ) deduped_players
        ), '[]'::jsonb),
        'matches', coalesce((
          select jsonb_agg(match order by ((match->>'createdAt')::bigint) desc)
          from (
            select distinct on (id) id, match
            from (
              select item->>'id' as id, item as match, 1 as priority
              from jsonb_array_elements(coalesce(public.rooms.data->'matches', '[]'::jsonb)) as item
              union all
              select item->>'id' as id, item as match, 2 as priority
              from jsonb_array_elements(coalesce(p_data->'matches', '[]'::jsonb)) as item
            ) merged_matches
            where id is not null
              and not (id in (
                select jsonb_array_elements_text(coalesce(public.rooms.data->'deletedMatchIds', '[]'::jsonb) || coalesce(p_data->'deletedMatchIds', '[]'::jsonb))
              ))
            order by id, priority desc
          ) deduped_matches
        ), '[]'::jsonb),
        'deletedPlayerIds', coalesce((
          select jsonb_agg(distinct deleted_id)
          from jsonb_array_elements_text(coalesce(public.rooms.data->'deletedPlayerIds', '[]'::jsonb) || coalesce(p_data->'deletedPlayerIds', '[]'::jsonb)) as deleted_id
        ), '[]'::jsonb),
        'deletedMatchIds', coalesce((
          select jsonb_agg(distinct deleted_id)
          from jsonb_array_elements_text(coalesce(public.rooms.data->'deletedMatchIds', '[]'::jsonb) || coalesce(p_data->'deletedMatchIds', '[]'::jsonb)) as deleted_id
        ), '[]'::jsonb)
      ),
      updated_at = now()
  where slug = p_slug
    and password_hash = p_password_hash;

  if not found then
    raise exception 'Room not found or wrong password';
  end if;
end;
$$;

grant execute on function public.join_room(text, text) to anon, authenticated;
grant execute on function public.save_room_data(text, text, jsonb) to anon, authenticated;
