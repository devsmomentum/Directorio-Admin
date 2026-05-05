-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.ad_campaigns (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  brand_name text NOT NULL,
  plan_type text NOT NULL,
  media_url text NOT NULL,
  media_type text NOT NULL,
  duration_seconds integer DEFAULT 15,
  start_date date DEFAULT CURRENT_DATE,
  end_date date,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  description text,
  priority_level integer DEFAULT 1,
  slot_limit_group text,
  target_frequency_seconds integer,
  store_id uuid,
  CONSTRAINT ad_campaigns_pkey PRIMARY KEY (id),
  CONSTRAINT ad_campaigns_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id)
);
CREATE TABLE public.analytics_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  module text NOT NULL,
  item_id uuid,
  item_name text NOT NULL,
  kiosk_id text DEFAULT 'K2-MAIN'::text,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  event_data jsonb,
  CONSTRAINT analytics_events_pkey PRIMARY KEY (id)
);
CREATE TABLE public.banners (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  media_url text NOT NULL,
  ui_position character varying NOT NULL CHECK (ui_position::text = ANY (ARRAY['top'::character varying, 'bottom'::character varying, 'home_hero'::character varying, 'sidebar'::character varying]::text[])),
  start_date timestamp with time zone,
  end_date timestamp with time zone,
  is_active boolean DEFAULT true,
  campaign_id uuid,
  slot_position integer,
  media_type text NOT NULL DEFAULT 'image'::text CHECK (media_type = ANY (ARRAY['image'::text, 'video'::text])),
  CONSTRAINT banners_pkey PRIMARY KEY (id),
  CONSTRAINT banners_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.ad_campaigns(id)
);
CREATE TABLE public.bathrooms (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  floor_level integer NOT NULL,
  local_number text,
  node_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT bathrooms_pkey PRIMARY KEY (id),
  CONSTRAINT bathrooms_node_fk FOREIGN KEY (node_id) REFERENCES public.map_nodes(id)
);
CREATE TABLE public.categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  icon text DEFAULT 'category'::text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT categories_pkey PRIMARY KEY (id)
);
CREATE TABLE public.coupon_leads (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  coupon_id uuid NOT NULL,
  first_name text,
  last_name text,
  id_document text,
  email text NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'::text),
  email_sent_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT coupon_leads_pkey PRIMARY KEY (id),
  CONSTRAINT coupon_leads_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.coupons(id)
);
CREATE TABLE public.coupons (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  store_id uuid,
  image_url text,
  code text UNIQUE,
  amount_available integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  title text DEFAULT 'Cupón Promocional'::text,
  price_usd numeric DEFAULT 0.00,
  campaign_id uuid,
  plan_type text NOT NULL DEFAULT 'IA_PERFORMANCE'::text CHECK (plan_type = ANY (ARRAY['DIAMANTE'::text, 'ORO'::text, 'IA_PERFORMANCE'::text, 'BONO_PREMIADO'::text, 'PUBLI_PROMO'::text])),
  start_date timestamp with time zone DEFAULT now(),
  end_date timestamp with time zone NOT NULL,
  category text,
  CONSTRAINT coupons_pkey PRIMARY KEY (id),
  CONSTRAINT coupons_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id),
  CONSTRAINT coupons_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.ad_campaigns(id)
);
CREATE TABLE public.kiosk_campaigns (
  kiosk_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT kiosk_campaigns_pkey PRIMARY KEY (kiosk_id, campaign_id),
  CONSTRAINT kiosk_campaigns_kiosk_id_fkey FOREIGN KEY (kiosk_id) REFERENCES public.kiosks(id),
  CONSTRAINT kiosk_campaigns_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.ad_campaigns(id)
);
CREATE TABLE public.kiosks (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name character varying NOT NULL,
  status character varying DEFAULT 'active'::character varying,
  node_id uuid,
  hardware_id text UNIQUE,
  paper_level text DEFAULT 'ok'::text,
  location_name text DEFAULT 'CC milemium'::text,
  location text,
  created_at timestamp with time zone DEFAULT now(),
  last_ping timestamp with time zone DEFAULT now(),
  is_emergency_active boolean NOT NULL DEFAULT false,
  floor_level text,
  CONSTRAINT kiosks_pkey PRIMARY KEY (id),
  CONSTRAINT kiosks_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.map_nodes(id)
);
CREATE TABLE public.map_calibration (
  floor_code text NOT NULL,
  scale double precision DEFAULT 1.0,
  ox double precision DEFAULT 0.0,
  oy double precision DEFAULT 0.0,
  oz double precision DEFAULT 0.0,
  rot_y double precision DEFAULT 0.0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT map_calibration_pkey PRIMARY KEY (floor_code)
);
CREATE TABLE public.map_edges (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  node_a_id uuid,
  node_b_id uuid,
  distance_weight double precision NOT NULL,
  is_3d boolean NOT NULL DEFAULT false,
  directional boolean NOT NULL DEFAULT false,
  CONSTRAINT map_edges_pkey PRIMARY KEY (id),
  CONSTRAINT map_edges_node_a_id_fkey FOREIGN KEY (node_a_id) REFERENCES public.map_nodes(id),
  CONSTRAINT map_edges_node_b_id_fkey FOREIGN KEY (node_b_id) REFERENCES public.map_nodes(id)
);
CREATE TABLE public.map_nodes (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  floor_level text NOT NULL,
  x double precision NOT NULL,
  y double precision NOT NULL,
  node_type character varying NOT NULL,
  z_height double precision DEFAULT 0.0,
  is_3d boolean NOT NULL DEFAULT false,
  connector_role text CHECK (connector_role = ANY (ARRAY['exit'::text, 'entry'::text, 'both'::text])),
  paired_node_id uuid,
  CONSTRAINT map_nodes_pkey PRIMARY KEY (id),
  CONSTRAINT map_nodes_paired_node_id_fkey FOREIGN KEY (paired_node_id) REFERENCES public.map_nodes(id)
);
CREATE TABLE public.map_polygons (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text,
  color text DEFAULT '#4466ff'::text,
  points jsonb,
  floor_level text,
  store_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT map_polygons_pkey PRIMARY KEY (id),
  CONSTRAINT map_polygons_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id)
);
CREATE TABLE public.map_routes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text,
  color text DEFAULT '#22d3ee'::text,
  points jsonb,
  floor_level text,
  origin_type text,
  origin_id uuid,
  dest_type text,
  dest_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT map_routes_pkey PRIMARY KEY (id)
);
CREATE TABLE public.pap_payment_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id text NOT NULL UNIQUE,
  barcode text,
  amount numeric NOT NULL,
  url_payment text,
  status text DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])),
  payment_method text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT pap_payment_orders_pkey PRIMARY KEY (id),
  CONSTRAINT pap_payment_orders_barcode_fkey FOREIGN KEY (barcode) REFERENCES public.parking_tickets(barcode)
);
CREATE TABLE public.parking_tickets (
  barcode text NOT NULL,
  enter_date timestamp with time zone,
  status text DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'paid'::text, 'exited'::text])),
  exit_code text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT parking_tickets_pkey PRIMARY KEY (barcode)
);
CREATE TABLE public.search_analytics (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  search_term character varying NOT NULL,
  search_type character varying NOT NULL,
  kiosk_id uuid,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()),
  CONSTRAINT search_analytics_pkey PRIMARY KEY (id),
  CONSTRAINT search_analytics_kiosk_id_fkey FOREIGN KEY (kiosk_id) REFERENCES public.kiosks(id)
);
CREATE TABLE public.services (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  provider text NOT NULL,
  description text,
  image_url text NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT services_pkey PRIMARY KEY (id)
);
CREATE TABLE public.stores (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name character varying NOT NULL,
  category character varying,
  description text,
  logo_url text,
  node_id uuid,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()),
  local_number text,
  floor_level text,
  category_id uuid,
  plan_type text CHECK (plan_type = ANY (ARRAY['DIAMANTE'::text, 'ORO'::text, 'IA_PERFORMANCE'::text])),
  CONSTRAINT stores_pkey PRIMARY KEY (id),
  CONSTRAINT stores_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.map_nodes(id),
  CONSTRAINT stores_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id)
);
CREATE TABLE public.temp_locales (
  Local text,
  Nombre_Tienda text,
  Categoria text
);
CREATE TABLE public.transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  transaction_type text NOT NULL CHECK (transaction_type = ANY (ARRAY['coupon'::text, 'service'::text])),
  item_id uuid,
  item_name text NOT NULL,
  amount_usd numeric NOT NULL,
  exchange_rate numeric NOT NULL,
  amount_bs numeric NOT NULL,
  payment_method text DEFAULT 'simulated'::text,
  status text DEFAULT 'completed'::text,
  user_email text,
  kiosk_id text DEFAULT 'K2-MAIN'::text,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT transactions_pkey PRIMARY KEY (id)
);