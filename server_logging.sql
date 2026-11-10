-- บันทึกประวัติสีฝั่งเซิร์ฟเวอร์ (ไม่ต้องเปิดหน้าเว็บ) — รันครั้งเดียวใน Supabase → SQL Editor
-- ต้องรัน phase.sql ก่อน (ใช้ตาราง batch_color_log และคอลัมน์ batch_started_at) และมีคอลัมน์ last_seen_at แล้ว
-- รันซ้ำได้ปลอดภัย
--
-- ทำอะไร: ทุก 10 นาที pg_cron เรียกฟังก์ชัน log_batch_color() ซึ่งคัดลอกค่าสี/อุณหภูมิล่าสุดจากแถว id = 1
--   ของ esp32_devices ลง batch_color_log โดยมีเงื่อนไข
--     1) มีรอบเพาะเลี้ยงอยู่ (batch_started_at ไม่ว่าง)
--     2) มีค่าสีครบ และบอร์ดส่งข้อมูลภายใน 15 นาทีล่าสุด (last_seen_at) — ไม่บันทึกค่าเก่าตอนบอร์ดดับ
--     3) ไม่ซ้ำค่าสีล่าสุดของรอบนั้น และห่างจากแถวล่าสุดอย่างน้อย 9 นาที
--   (แถวที่ผู้ใช้มาร์กป้ายเองไม่ถูกแตะ และฟังก์ชันไม่เขียน label)
--
-- หมายเหตุ: หน้าเว็บยังบันทึกอัตโนมัติทุก 10 นาทีของมันเองด้วย ถ้าเปิดค้างไว้อาจได้แถวเพิ่มซ้อนกันบ้าง
--   (ไม่เสียหาย แค่ถี่ขึ้น) ฟังก์ชันนี้เว้น 9 นาทีหลังแถวล่าสุดไม่ว่ามาจากแหล่งใด

-- 1) pg_cron (ถ้า error ให้เปิดที่ Dashboard → Database → Extensions → pg_cron แล้วรันส่วนที่เหลือต่อ)
create extension if not exists pg_cron with schema pg_catalog;

-- 2) ฟังก์ชันบันทึก
create or replace function public.log_batch_color()
returns void
language plpgsql
as $$
declare
  d record;
  l record;
begin
  select batch_started_at, color_r, color_g, color_b, color_c, temperature, last_seen_at
    into d
    from public.esp32_devices
   where id = 1;

  if not found or d.batch_started_at is null then return; end if;
  if d.color_r is null or d.color_g is null or d.color_b is null then return; end if;
  if d.last_seen_at is null or d.last_seen_at < now() - interval '15 minutes' then return; end if;

  select logged_at, color_r, color_g, color_b, color_c
    into l
    from public.batch_color_log
   where batch_started_at = d.batch_started_at
   order by logged_at desc
   limit 1;

  if found then
    if l.logged_at > now() - interval '9 minutes' then return; end if;
    if l.color_r is not distinct from d.color_r
       and l.color_g is not distinct from d.color_g
       and l.color_b is not distinct from d.color_b
       and l.color_c is not distinct from d.color_c then
      return;
    end if;
  end if;

  insert into public.batch_color_log
    (batch_started_at, color_r, color_g, color_b, color_c, temperature, label)
  values
    (d.batch_started_at, d.color_r, d.color_g, d.color_b, d.color_c, d.temperature, '');
end;
$$;

-- ไม่ให้ anon/authenticated เรียกฟังก์ชันนี้ผ่าน API (ให้ cron เรียกเท่านั้น)
revoke all on function public.log_batch_color() from public, anon, authenticated;

-- 3) ตั้งเวลา ทุก 10 นาที (ลบงานเดิมชื่อเดียวกันก่อน เพื่อให้รันซ้ำได้)
select cron.unschedule('log-batch-color')
 where exists (select 1 from cron.job where jobname = 'log-batch-color');

select cron.schedule('log-batch-color', '*/10 * * * *', $$select public.log_batch_color();$$);

-- ตรวจผล (รันแยกเมื่อต้องการ):
--   select jobname, schedule, active from cron.job where jobname = 'log-batch-color';
--   select status, return_message, start_time from cron.job_run_details
--     where jobid = (select jobid from cron.job where jobname = 'log-batch-color')
--     order by start_time desc limit 5;
--   select logged_at, color_r, color_g, color_b, temperature, label from public.batch_color_log
--     order by logged_at desc limit 10;
-- ยกเลิก:
--   select cron.unschedule('log-batch-color');
