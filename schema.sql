-- هاني سوفت — مخطط قاعدة البيانات والإجراءات المالية
-- نفّذ الملف كاملاً من Supabase Dashboard > SQL Editor في مشروع جديد.
-- اختبر أولاً على مشروع تجريبي. لا تمنح أي شخص مفتاح service_role.

create extension if not exists pgcrypto;
create schema if not exists private;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-zA-Z0-9_]{3,24}$'),
  display_name text,
  role text not null default 'customer' check (role in ('customer','admin','owner')),
  permissions text[] not null default '{}',
  wallet_balance numeric(14,2) not null default 0 check (wallet_balance >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  description text not null default '',
  price numeric(14,2) not null check (price >= 0),
  currency text not null default 'USD' check (currency in ('USD','SDG')),
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  service_id uuid references public.services(id),
  service_name text not null,
  amount numeric(14,2) not null check (amount >= 0),
  currency text not null check (currency in ('USD','SDG')),
  status text not null default 'pending' check (status in ('pending','processing','completed','cancelled')),
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  kind text not null check (kind in ('admin_credit','deposit_credit','service_debit','transfer_in','transfer_out','refund')),
  amount numeric(14,2) not null check (amount > 0),
  currency text not null check (currency in ('USD','SDG')),
  related_user_id uuid references auth.users(id),
  related_order_id uuid references public.orders(id),
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.deposit_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  amount numeric(14,2) not null check (amount > 0),
  currency text not null check (currency in ('USD','SDG')),
  reference text not null default '',
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  rating int not null check (rating between 1 and 5),
  comment text not null default '',
  is_published boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists orders_user_created_idx on public.orders(user_id, created_at desc);
create index if not exists ledger_user_created_idx on public.wallet_transactions(user_id, created_at desc);
create index if not exists deposits_status_created_idx on public.deposit_requests(status, created_at);
create index if not exists services_active_idx on public.services(is_active, created_at desc);

create or replace function private.is_staff(p_permission text default null)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and (
        p.role = 'owner'
        or (p.role = 'admin' and (p_permission is null or p_permission = any(p.permissions)))
      )
  );
$$;
revoke all on function private.is_staff(text) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_staff(text) to authenticated;

-- إنشاء ملف العميل من بيانات التسجيل الوصفية.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare v_username text;
begin
  v_username := lower(coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1)));
  if v_username !~ '^[a-zA-Z0-9_]{3,24}$' then
    v_username := 'user_' || replace(substr(new.id::text,1,12),'-','');
  end if;
  insert into public.profiles(id, username, display_name)
  values(new.id, v_username, coalesce(new.raw_user_meta_data->>'display_name',v_username))
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

-- تسجيل الدخول باسم المستخدم يتم عبر Supabase Edge Function username-login،
-- وليس عبر RPC عامة تكشف البريد المقابل لاسم المستخدم.

-- منع تعديل الرصيد أو الدور/الصلاحيات مباشرة من العميل.
alter table public.profiles enable row level security;
alter table public.services enable row level security;
alter table public.orders enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.deposit_requests enable row level security;
alter table public.reviews enable row level security;

drop policy if exists "profile self read" on public.profiles;
create policy "profile self read" on public.profiles for select to authenticated using (id = (select auth.uid()) or private.is_staff(null));
drop policy if exists "staff profile read" on public.profiles;
create policy "profile self update display" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
-- لا تمنح UPDATE على role/permissions/wallet_balance للواجهة.
revoke update on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

drop policy if exists "public read active services" on public.services;
drop policy if exists "authenticated read active or staff services" on public.services;
create policy "public read active services" on public.services for select to anon using (is_active);
create policy "authenticated read active or staff services" on public.services for select to authenticated using (is_active or private.is_staff('manage_services'));
drop policy if exists "staff insert services" on public.services;
create policy "staff insert services" on public.services for insert to authenticated with check (private.is_staff('manage_services') and created_by = (select auth.uid()));
drop policy if exists "staff update services" on public.services;
create policy "staff update services" on public.services for update to authenticated using (private.is_staff('manage_services')) with check (private.is_staff('manage_services'));
drop policy if exists "staff delete services" on public.services;
create policy "staff delete services" on public.services for delete to authenticated using (private.is_staff('manage_services'));
grant select on public.services to anon, authenticated;
grant insert, update, delete on public.services to authenticated;

drop policy if exists "orders own or staff read" on public.orders;
create policy "orders own or staff read" on public.orders for select to authenticated using (user_id = (select auth.uid()) or private.is_staff('manage_orders'));
grant select on public.orders to authenticated;

drop policy if exists "ledger own or staff read" on public.wallet_transactions;
create policy "ledger own or staff read" on public.wallet_transactions for select to authenticated using (user_id = (select auth.uid()) or private.is_staff('review_deposits'));
grant select on public.wallet_transactions to authenticated;

drop policy if exists "deposit own read" on public.deposit_requests;
create policy "deposit own read" on public.deposit_requests for select to authenticated using (user_id = (select auth.uid()) or private.is_staff('review_deposits'));
drop policy if exists "deposit own create" on public.deposit_requests;
create policy "deposit own create" on public.deposit_requests for insert to authenticated with check (user_id = (select auth.uid()) and status = 'pending' and reviewed_by is null and amount > 0);
grant select, insert on public.deposit_requests to authenticated;

drop policy if exists "published reviews read" on public.reviews;
drop policy if exists "published reviews public" on public.reviews;
drop policy if exists "reviews owner or staff read" on public.reviews;
create policy "published reviews public" on public.reviews for select to anon using (is_published);
create policy "reviews owner or staff read" on public.reviews for select to authenticated using (is_published or user_id = (select auth.uid()) or private.is_staff('manage_reviews'));
grant select on public.reviews to anon, authenticated;

-- إنشاء طلب خدمة وخصم الرصيد داخل معاملة واحدة.
create or replace function public.create_service_order(p_service_id uuid)
returns uuid language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_service public.services%rowtype; v_order uuid;
begin
  if v_uid is null then raise exception 'يجب تسجيل الدخول'; end if;
  select * into v_service from public.services where id=p_service_id and is_active=true for share;
  if not found then raise exception 'الخدمة غير متاحة'; end if;
  if v_service.currency <> 'USD' then
    raise exception 'المحفظة الأساسية في هذه النسخة بالدولار فقط؛ وحّد عملة الخدمة قبل الطلب';
  end if;
  update public.profiles set wallet_balance=wallet_balance-v_service.price
    where id=v_uid and wallet_balance >= v_service.price;
  if not found then raise exception 'الرصيد غير كافٍ'; end if;
  insert into public.orders(user_id,service_id,service_name,amount,currency)
    values(v_uid,v_service.id,v_service.name,v_service.price,v_service.currency) returning id into v_order;
  insert into public.wallet_transactions(user_id,kind,amount,currency,related_order_id,note)
    values(v_uid,'service_debit',v_service.price,v_service.currency,v_order,'خصم مقابل طلب خدمة: '||v_service.name);
  return v_order;
end;
$$;
revoke all on function public.create_service_order(uuid) from public, anon;
grant execute on function public.create_service_order(uuid) to authenticated;

create or replace function public.transfer_wallet(p_recipient_username text,p_amount numeric,p_note text default '')
returns void language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_recipient uuid; v_currency text := 'USD';
begin
  if v_uid is null then raise exception 'يجب تسجيل الدخول'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000 then raise exception 'المبلغ غير صالح'; end if;
  select id into v_recipient from public.profiles where lower(username)=lower(trim(p_recipient_username));
  if v_recipient is null then raise exception 'المستلم غير موجود'; end if;
  if v_recipient=v_uid then raise exception 'لا يمكنك التحويل إلى نفسك'; end if;
  -- النسخة الأساسية تستخدم محفظة موحدة بالدولار. لا تخلط العملات قبل ضبط أسعار الصرف.
  update public.profiles set wallet_balance=wallet_balance-p_amount where id=v_uid and wallet_balance>=p_amount;
  if not found then raise exception 'الرصيد غير كافٍ'; end if;
  update public.profiles set wallet_balance=wallet_balance+p_amount where id=v_recipient;
  insert into public.wallet_transactions(user_id,kind,amount,currency,related_user_id,note)
    values(v_uid,'transfer_out',p_amount,v_currency,v_recipient,left(coalesce(p_note,''),120));
  insert into public.wallet_transactions(user_id,kind,amount,currency,related_user_id,note)
    values(v_recipient,'transfer_in',p_amount,v_currency,v_uid,left(coalesce(p_note,''),120));
end;
$$;
revoke all on function public.transfer_wallet(text,numeric,text) from public, anon;
grant execute on function public.transfer_wallet(text,numeric,text) to authenticated;

-- اعتماد طلب الشحن يضيف الرصيد مرة واحدة فقط. لا تستعمله قبل التحقق من الدفع خارج النظام.
create or replace function public.admin_approve_deposit(p_deposit_id uuid)
returns void language plpgsql security definer
set search_path = ''
as $$
declare d public.deposit_requests%rowtype;
begin
  if not private.is_staff('review_deposits') then raise exception 'ليس لديك صلاحية اعتماد الشحن'; end if;
  select * into d from public.deposit_requests where id=p_deposit_id for update;
  if not found then raise exception 'طلب الشحن غير موجود'; end if;
  if d.status <> 'pending' then raise exception 'تمت معالجة هذا الطلب مسبقاً'; end if;
  if d.currency <> 'USD' then raise exception 'المحفظة الأساسية بالدولار فقط؛ لا تعتمد شحنًا بعملة أخرى قبل تفعيل محفظة متعددة العملات'; end if;
  update public.profiles set wallet_balance=wallet_balance+d.amount where id=d.user_id;
  update public.deposit_requests set status='approved',reviewed_by=auth.uid(),reviewed_at=now() where id=d.id;
  insert into public.wallet_transactions(user_id,kind,amount,currency,note)
    values(d.user_id,'deposit_credit',d.amount,d.currency,'اعتماد طلب شحن '||d.id::text);
end;
$$;
revoke all on function public.admin_approve_deposit(uuid) from public, anon;
grant execute on function public.admin_approve_deposit(uuid) to authenticated;

create or replace function public.admin_update_order_status(p_order_id uuid,p_status text,p_note text default null)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.is_staff('manage_orders') then raise exception 'ليس لديك صلاحية إدارة الطلبات'; end if;
  if p_status not in ('pending','processing','completed','cancelled') then raise exception 'حالة غير صحيحة'; end if;
  update public.orders set status=p_status,admin_note=left(p_note,500),updated_at=now() where id=p_order_id;
  if not found then raise exception 'الطلب غير موجود'; end if;
end;
$$;
revoke all on function public.admin_update_order_status(uuid,text,text) from public, anon;
grant execute on function public.admin_update_order_status(uuid,text,text) to authenticated;

create or replace function public.submit_service_review(p_order_id uuid,p_rating int,p_comment text default '')
returns uuid language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_review uuid;
begin
  if v_uid is null then raise exception 'يجب تسجيل الدخول'; end if;
  if p_rating < 1 or p_rating > 5 then raise exception 'التقييم يجب أن يكون بين 1 و5'; end if;
  if not exists(select 1 from public.orders where id=p_order_id and user_id=v_uid and status='completed') then
    raise exception 'يمكن تقييم الطلب المكتمل الخاص بك فقط';
  end if;
  insert into public.reviews(order_id,user_id,rating,comment)
    values(p_order_id,v_uid,p_rating,left(coalesce(p_comment,''),1000)) returning id into v_review;
  return v_review;
end;
$$;
revoke all on function public.submit_service_review(uuid,int,text) from public, anon;
grant execute on function public.submit_service_review(uuid,int,text) to authenticated;

-- إضافة خدمة / إعداد أول مدير:
-- 1) أنشئ حساب المالك من واجهة الموقع ثم نفّذ استعلام تحديد الدور باستخدام بريده:
-- update public.profiles p set role='owner', permissions=array['manage_services','review_deposits','manage_orders','manage_reviews']
-- from auth.users u where p.id=u.id and lower(u.email)=lower('OWNER_EMAIL_HERE');
-- لا تضع هذا التحديث في الواجهة العامة.
--
-- المسؤول:
-- update public.profiles p set role='admin',
-- permissions=array['manage_services','review_deposits','manage_orders','manage_reviews']
-- from auth.users u where p.id=u.id and lower(u.email)=lower('ADMIN_EMAIL_HERE');
--
-- ملاحظة مهمة: هذا المخطط لا يربط بوابة دفع حقيقية. deposit_requests طلبات مراجعة فقط.
