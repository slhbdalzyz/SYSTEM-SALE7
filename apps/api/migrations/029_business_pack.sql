-- More kinds of shop: building materials, car parts, wholesale, stationery, perfumes, bakeries,
-- furniture. Most of it is shared: prices by kind of customer, quotes, orders taken ahead with a
-- deposit, ready-made lists, instalments, and where a part sits and what car it fits.

-- Prices by kind of customer: a contractor or a workshop pays its own price for the same unit.
ALTER TABLE customers ADD COLUMN price_tier text NOT NULL DEFAULT 'retail' CHECK (price_tier IN ('retail', 'wholesale', 'contractor', 'workshop'));
CREATE TABLE unit_prices (
  unit_id uuid NOT NULL REFERENCES product_units(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tier text NOT NULL CHECK (tier IN ('wholesale', 'contractor', 'workshop')),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  PRIMARY KEY (unit_id, tier)
);
CREATE INDEX unit_prices_tenant ON unit_prices (tenant_id);

-- Car parts (and any shop with a big store room): the maker's part number, the cars it fits, the shelf.
ALTER TABLE products ADD COLUMN part_number text;
ALTER TABLE products ADD COLUMN fits text;
ALTER TABLE products ADD COLUMN location text;
CREATE INDEX products_part_number ON products (tenant_id, upper(part_number)) WHERE part_number IS NOT NULL;

-- A price offer: printed or sent on WhatsApp, and opened on the till by its number when the customer buys.
CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid REFERENCES stores(id) ON DELETE SET NULL,
  number int NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name text,
  phone text,
  project text,
  lines jsonb NOT NULL,
  total_minor bigint NOT NULL,
  valid_until date,
  note text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sold', 'cancelled')),
  sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  UNIQUE (tenant_id, number)
);
CREATE INDEX quotes_open ON quotes (tenant_id, status, created_at);

-- On a sale: the quote it came from, the building site it is for, and where it goes.
ALTER TABLE sales ADD COLUMN quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL;
ALTER TABLE sales ADD COLUMN project text;
ALTER TABLE sales ADD COLUMN delivery jsonb;
CREATE INDEX sales_delivery ON sales (tenant_id, created_at) WHERE delivery IS NOT NULL;

-- Orders taken ahead with a deposit (a birthday cake, a tailored suit, a part to bring in) live
-- beside repairs, with a day they are due.
ALTER TABLE repairs ADD COLUMN kind text NOT NULL DEFAULT 'repair' CHECK (kind IN ('repair', 'order'));
ALTER TABLE repairs ADD COLUMN due_at timestamptz;
ALTER TABLE repairs DROP CONSTRAINT IF EXISTS repairs_tenant_id_number_key;
ALTER TABLE repairs ADD CONSTRAINT repairs_number UNIQUE (tenant_id, kind, number);
CREATE INDEX repairs_due ON repairs (tenant_id, due_at) WHERE due_at IS NOT NULL;

-- A ready-made list put on the bill in one go: a school list, a bathroom set, a gift box.
CREATE TABLE kits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  lines jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- Sold in instalments: what is owed, what was paid down, and how many monthly payments.
CREATE TABLE installment_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  title text NOT NULL,
  sale_number text,
  total_minor bigint NOT NULL CHECK (total_minor > 0),
  down_minor bigint NOT NULL DEFAULT 0 CHECK (down_minor >= 0),
  count int NOT NULL CHECK (count BETWEEN 1 AND 120),
  first_due date NOT NULL,
  note text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id)
);
CREATE INDEX installment_plans_customer ON installment_plans (customer_id, status);
CREATE INDEX installment_plans_open ON installment_plans (tenant_id, status);

CREATE FUNCTION pos_building_departments(tid uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO categories (tenant_id, name, icon, sort)
  SELECT tid, d.name, d.icon, d.sort FROM (VALUES
    ('أسمنت وحديد', '🧱', 1), ('بلاط وسيراميك', '🔲', 2), ('أدوات صحية', '🚿', 3), ('مواسير وتمديدات', '🔧', 4),
    ('كوابل وأسلاك', '🔌', 5), ('مفاتيح وأفياش', '💡', 6), ('إنارة', '🔦', 7), ('دهانات', '🎨', 8),
    ('عدد وأدوات', '🛠️', 9), ('مسامير وبراغي', '🔩', 10)
  ) AS d(name, icon, sort)
  ON CONFLICT (tenant_id, name) DO NOTHING;
$$;

CREATE FUNCTION pos_auto_parts_departments(tid uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO categories (tenant_id, name, icon, sort)
  SELECT tid, d.name, d.icon, d.sort FROM (VALUES
    ('زيوت وفلاتر', '🛢️', 1), ('فرامل', '🛑', 2), ('محرك', '⚙️', 3), ('عفشة وتعليق', '🔩', 4),
    ('كهرباء السيارة', '🔋', 5), ('تبريد ومكيف', '❄️', 6), ('إطارات', '🛞', 7), ('هيكل وإضاءة', '🚘', 8),
    ('إكسسوارات', '✨', 9)
  ) AS d(name, icon, sort)
  ON CONFLICT (tenant_id, name) DO NOTHING;
$$;

CREATE FUNCTION pos_wholesale_departments(tid uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO categories (tenant_id, name, icon, sort)
  SELECT tid, d.name, d.icon, d.sort FROM (VALUES
    ('مواد غذائية جافة', '🍚', 1), ('معلبات', '🥫', 2), ('زيوت وسمن', '🫒', 3), ('مشروبات', '🥤', 4),
    ('منظفات', '🧴', 5), ('ورقيات', '🧻', 6), ('حلويات وبسكويت', '🍪', 7), ('ألبان وأجبان', '🧀', 8)
  ) AS d(name, icon, sort)
  ON CONFLICT (tenant_id, name) DO NOTHING;
$$;

CREATE FUNCTION pos_stationery_departments(tid uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO categories (tenant_id, name, icon, sort)
  SELECT tid, d.name, d.icon, d.sort FROM (VALUES
    ('كراسات ودفاتر', '📓', 1), ('أقلام', '🖊️', 2), ('أدوات هندسية', '📐', 3), ('شنط مدرسية', '🎒', 4),
    ('ألوان ورسم', '🖍️', 5), ('ورق ومستلزمات مكتبية', '📄', 6), ('كتب وقصص', '📚', 7), ('طباعة وتصوير', '🖨️', 8),
    ('هدايا وتغليف', '🎁', 9)
  ) AS d(name, icon, sort)
  ON CONFLICT (tenant_id, name) DO NOTHING;
$$;

CREATE FUNCTION pos_perfume_departments(tid uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO categories (tenant_id, name, icon, sort)
  SELECT tid, d.name, d.icon, d.sort FROM (VALUES
    ('عطور جاهزة', '🌸', 1), ('زيوت عطرية', '💧', 2), ('عطور مركبة', '🧪', 3), ('بخور وعود', '🪔', 4),
    ('مكياج', '💄', 5), ('عناية بالبشرة', '🧴', 6), ('عناية بالشعر', '💇', 7), ('بوكسات هدايا', '🎁', 8),
    ('قوارير وتعبئة', '🫙', 9)
  ) AS d(name, icon, sort)
  ON CONFLICT (tenant_id, name) DO NOTHING;
$$;

CREATE FUNCTION pos_bakery_departments(tid uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO categories (tenant_id, name, icon, sort)
  SELECT tid, d.name, d.icon, d.sort FROM (VALUES
    ('خبز', '🍞', 1), ('معجنات', '🥐', 2), ('حلويات شرقية', '🍯', 3), ('تورتات وكيك', '🎂', 4),
    ('حلويات غربية', '🍰', 5), ('بسكويت ومعمول', '🍪', 6), ('مشروبات', '☕', 7), ('مواد خام', '📦', 8)
  ) AS d(name, icon, sort)
  ON CONFLICT (tenant_id, name) DO NOTHING;
$$;

CREATE FUNCTION pos_furniture_departments(tid uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO categories (tenant_id, name, icon, sort)
  SELECT tid, d.name, d.icon, d.sort FROM (VALUES
    ('غرف نوم', '🛏️', 1), ('صالونات وكنب', '🛋️', 2), ('سفرة ومطابخ', '🍽️', 3), ('مفروشات وسجاد', '🧶', 4),
    ('ثلاجات وغسالات', '🧊', 5), ('مكيفات', '❄️', 6), ('شاشات', '📺', 7), ('أجهزة صغيرة', '🔌', 8)
  ) AS d(name, icon, sort)
  ON CONFLICT (tenant_id, name) DO NOTHING;
$$;
