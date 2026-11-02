-- รอบเพาะเลี้ยง + เฟสจุลินทรีย์สังเคราะห์แสง (PSB) — รันครั้งเดียวใน Supabase → SQL Editor
-- รันซ้ำได้ปลอดภัย (idempotent)

-- 1) คอลัมน์รอบเพาะเลี้ยงในตารางอุปกรณ์ (แถว id = 1)
alter table public.esp32_devices add column if not exists batch_started_at timestamptz;
alter table public.esp32_devices add column if not exists batch_name text not null default '';

-- 2) ตารางประวัติสีของแต่ละรอบ
create table if not exists public.batch_color_log (
  id bigserial primary key,
  batch_started_at timestamptz not null,
  logged_at timestamptz not null default now(),
  color_r int,
  color_g int,
  color_b int,
  color_c int,
  temperature double precision,
  label text not null default ''
);

create index if not exists batch_color_log_batch_idx
  on public.batch_color_log (batch_started_at, logged_at desc);

-- 3) RLS: anon ทำได้เฉพาะ select และ insert (ห้าม update / delete)
alter table public.batch_color_log enable row level security;

revoke all on public.batch_color_log from anon;
grant select, insert on public.batch_color_log to anon;
grant usage on sequence public.batch_color_log_id_seq to anon;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'batch_color_log' and policyname = 'anon_select_batch_color_log') then
    create policy anon_select_batch_color_log on public.batch_color_log
      for select to anon using (true);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'batch_color_log' and policyname = 'anon_insert_batch_color_log') then
    create policy anon_insert_batch_color_log on public.batch_color_log
      for insert to anon with check (true);
  end if;
end $$;

-- 4) esp32_devices: ไม่ต้องเปลี่ยนสิทธิ์ — เว็บ update แถว id = 1 ได้อยู่แล้ว
--    (คอลัมน์ใหม่ batch_started_at / batch_name ใช้นโยบาย update เดิมของตารางนี้)
--    ถ้าตารางนี้เปิด RLS แต่ยังไม่มีนโยบาย update ให้ anon ให้เพิ่มเอง เช่น:
--    create policy anon_update_esp32_devices on public.esp32_devices
--      for update to anon using (id = 1) with check (id = 1);
