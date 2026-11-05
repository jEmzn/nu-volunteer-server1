-- Example only. Copy, replace the codes with long random ones, and run once. Do not commit real codes:
-- an organisation code is the only thing needed to sign in as a supervisor.
insert into orgs (code, name, admin) values
  ('CHANGE-ME-CENTRE-ADMIN', 'ศูนย์จิตอาสา กองกิจการนิสิต', true),
  ('CHANGE-ME-CENTRE', 'ศูนย์จิตอาสา กองกิจการนิสิต', false)
on conflict (code) do update set name = excluded.name, admin = excluded.admin;
