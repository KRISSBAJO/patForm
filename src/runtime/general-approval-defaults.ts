import type { Client } from './db.js';

/** A usable first policy, created once for each workspace. Admins may edit or turn it off. */
export async function seedDefaultGeneralApproval(client: Client, tenantId: string, createdBy: string | null) {
  await client.query(
    `insert into general_request_type
       (tenant_id, seed_key, name, description, fields, attachment_rule, steps, created_by)
     values ($1, 'general', 'General request',
       'For everyday work requests. Your manager reviews it; if no manager is assigned, another workspace owner or admin reviews it.',
       $2::jsonb, 'optional', $3::jsonb, $4)
     on conflict (tenant_id, seed_key) do nothing`,
    [tenantId,
      JSON.stringify([{ key: 'details', label: 'What do you need and why?', type: 'long_text', required: true }, { key: 'needed_by', label: 'When do you need it?', type: 'date', required: false }]),
      JSON.stringify([{ name: 'Manager approval', responsible: [{ kind: 'manager' }], mode: 'any' }]),
      createdBy],
  );
}
