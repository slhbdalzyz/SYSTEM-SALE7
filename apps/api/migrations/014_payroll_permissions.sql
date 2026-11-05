-- 1. More jobs (accountant, data entry), and per-person permissions the owner can tick.
--    NULL permissions means "what the job normally has".
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'manager', 'accountant', 'data_entry', 'cashier'));
ALTER TABLE users ADD COLUMN permissions text[];

-- 2. Every member of staff is an employee with a monthly salary.
ALTER TABLE users ADD COLUMN job_title text;
ALTER TABLE users ADD COLUMN salary_minor bigint NOT NULL DEFAULT 0 CHECK (salary_minor >= 0);
ALTER TABLE users ADD COLUMN day_minutes integer NOT NULL DEFAULT 480 CHECK (day_minutes BETWEEN 60 AND 1440);
ALTER TABLE users ADD COLUMN hired_on date;

-- The salary a month was worked out on, kept so a later raise does not rewrite old months.
CREATE TABLE payroll_months (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  salary_minor bigint NOT NULL CHECK (salary_minor >= 0),
  UNIQUE (user_id, month)
);

-- Everything that changes what an employee takes home in a month.
CREATE TABLE payroll_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  kind text NOT NULL CHECK (kind IN ('bonus', 'return', 'purchase', 'advance', 'late', 'absence', 'unpaid_leave', 'deduction', 'paid_leave', 'payment')),
  amount_minor bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  days integer CHECK (days > 0),
  minutes integer CHECK (minutes > 0),
  on_date date NOT NULL DEFAULT CURRENT_DATE,
  note text,
  sale_id uuid REFERENCES sales(id),
  expense_id uuid REFERENCES expenses(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payroll_entries_user ON payroll_entries (tenant_id, user_id, month);

-- 3. Staff buying from the shop: the till can put the bill on the employee's salary.
ALTER TABLE sales ADD COLUMN employee_id uuid REFERENCES users(id);
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('cash', 'card', 'credit', 'payroll'));
