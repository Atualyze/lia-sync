-- Pedidos InfinitePay/Pix: fonte durável do estado financeiro do checkout.
create table if not exists public.payment_orders (
  order_nsu text primary key,
  status text not null default 'pending' check (status in ('pending','paid','failed','cancelled')),
  conversation_id uuid references public.conversations(id) on delete set null,
  phone text not null default '',
  client_name text not null default '',
  payment_method text not null default 'checkout' check (payment_method in ('checkout','pix_key','pix_copy_paste')),
  amount_cents integer not null check (amount_cents >= 0),
  paid_amount_cents integer not null default 0 check (paid_amount_cents >= 0),
  description text not null default '',
  handle text not null default '',
  checkout_url text not null default '',
  payment_url text not null default '',
  slug text not null default '',
  transaction_nsu text not null default '',
  capture_method text not null default '',
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists payment_orders_phone_created_idx on public.payment_orders (phone, created_at desc);
create index if not exists payment_orders_status_created_idx on public.payment_orders (status, created_at desc);
drop trigger if exists payment_orders_set_updated_at on public.payment_orders;
create trigger payment_orders_set_updated_at before update on public.payment_orders for each row execute function public.set_updated_at();
alter table public.payment_orders enable row level security;
comment on table public.payment_orders is 'Pedidos e confirmações de pagamento; acesso somente pelo backend service-role.';
