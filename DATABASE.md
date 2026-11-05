## Table `students`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `text` | Primary |
| `name` | `text` |  |
| `created_at` | `timestamptz` |  |
| `reminders` | `_text` |  |
| `notify` | `jsonb` |  |

## Table `orgs`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `code` | `text` | Primary |
| `name` | `text` |  |
| `admin` | `bool` |  |

## Table `activities`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `text` | Primary |
| `title` | `text` |  |
| `category_key` | `text` |  |
| `org` | `text` |  |
| `org_code` | `text` |  |
| `poster` | `text` |  |
| `description` | `text` |  |
| `place` | `text` |  |
| `lat` | `float8` |  Nullable |
| `lng` | `float8` |  Nullable |
| `start_at` | `timestamptz` |  |
| `end_at` | `timestamptz` |  |
| `hours` | `float8` |  |
| `cap_limit` | `bool` |  |
| `capacity` | `int4` |  |
| `walk_in` | `bool` |  |
| `qr_mode` | `text` |  |
| `loc_mode` | `text` |  |
| `radius` | `int4` |  |
| `qr_interval` | `int4` |  |
| `supervisor_name` | `text` |  |
| `supervisor_phone` | `text` |  |
| `chat_enabled` | `bool` |  |
| `open_chat_url` | `text` |  Nullable |
| `opens_at` | `timestamptz` |  Nullable |
| `cancel_days` | `int4` |  Nullable |
| `closed_at` | `timestamptz` |  Nullable |
| `submitted_at` | `timestamptz` |  Nullable |
| `recorded_at` | `timestamptz` |  Nullable |
| `hidden` | `bool` |  Nullable |
| `hide_until_open` | `bool` |  Nullable |
| `created_at` | `timestamptz` |  |
| `reg_count` | `int4` |  |
| `credit_count` | `int4` |  |
| `items_per_hour` | `int4` |  Nullable |
| `template_id` | `text` |  Nullable |

## Table `registrations`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `activity_id` | `text` | Primary |
| `student_id` | `text` | Primary |
| `name` | `text` |  |
| `at` | `timestamptz` |  |
| `walk_in` | `bool` |  |
| `cancelled_at` | `timestamptz` |  Nullable |
| `late` | `bool` |  |
| `waived` | `bool` |  |

## Table `credits`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `activity_id` | `text` | Primary |
| `student_id` | `text` | Primary |
| `name` | `text` |  |
| `hours` | `float8` |  |
| `full_hours` | `float8` |  |
| `at` | `timestamptz` |  |
| `method` | `text` |  |
| `distance` | `float8` |  Nullable |
| `accuracy` | `float8` |  Nullable |
| `flags` | `_text` |  |
| `device_id` | `text` |  Nullable |
| `ref` | `text` |  Nullable |
| `edited_by` | `text` |  Nullable |
| `edited_at` | `timestamptz` |  Nullable |
| `reason` | `text` |  Nullable |
| `items` | `int4` |  Nullable |

## Table `announcements`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `activity_id` | `text` |  |
| `text` | `text` |  |
| `images` | `_text` |  |
| `at` | `timestamptz` |  |

## Table `messages`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `activity_id` | `text` |  |
| `author_id` | `text` |  |
| `author_name` | `text` |  |
| `text` | `text` |  |
| `at` | `timestamptz` |  |
| `sup` | `bool` |  |

## Table `dms`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `activity_id` | `text` |  |
| `student_id` | `text` |  |
| `from_sup` | `bool` |  |
| `author_name` | `text` |  |
| `text` | `text` |  |
| `at` | `timestamptz` |  |
| `read` | `bool` |  |

## Table `notices`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `student_id` | `text` |  |
| `kind` | `text` |  |
| `title` | `text` |  |
| `body` | `text` |  |
| `activity_id` | `text` |  Nullable |
| `to` | `text` |  Nullable |
| `at` | `timestamptz` |  |
| `read` | `bool` |  |

## Table `templates`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `text` | Primary |
| `org_code` | `text` |  |
| `title` | `text` |  |
| `poster` | `text` |  |
| `description` | `text` |  |
| `hours` | `float8` |  |
| `settings` | `jsonb` |  |
| `created_by` | `text` |  |
| `created_at` | `timestamptz` |  |

## RLS Policies

### `activities`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `signed in` | ALL | authenticated | PERMISSIVE | `true` | `true` |

### `students`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `signed in` | ALL | authenticated | PERMISSIVE | `true` | `true` |

### `announcements`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `signed in` | ALL | authenticated | PERMISSIVE | `true` | `true` |

### `messages`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `signed in` | ALL | authenticated | PERMISSIVE | `true` | `true` |

### `dms`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `signed in` | ALL | authenticated | PERMISSIVE | `true` | `true` |

### `notices`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `signed in` | ALL | authenticated | PERMISSIVE | `true` | `true` |

### `registrations`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `signed in` | ALL | authenticated | PERMISSIVE | `true` | `true` |

### `credits`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `signed in` | ALL | authenticated | PERMISSIVE | `true` | `true` |

### `templates`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `signed in` | ALL | authenticated | PERMISSIVE | `true` | `true` |

