import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { submitMessageTemplate } from '@/lib/whatsapp/meta-api'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'
import { hasMinRole, isAccountRole } from '@/lib/auth/roles'

interface ExistingTemplateRow {
  id: string
  user_id: string
  status: string
  meta_template_id: string | null
}

/** Shared persistence payload for both Meta success and safe draft failure. */
function buildTemplateRow(
  accountId: string,
  userId: string,
  payload: TemplatePayload,
  extras: {
    status: 'DRAFT' | string
    metaTemplateId: string | null
    submissionError: string | null
  },
) {
  return {
    // Account tenancy — required NOT NULL on message_templates as
    // of migration 017. Without this an INSERT throws on the
    // not-null constraint.
    account_id: accountId,
    // Original author — kept as audit only. Template identity is scoped to
    // the account by (account_id, name, language), so teammates update the
    // same local Meta template variant instead of shadowing one another.
    user_id: userId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    header_handle: payload.header_handle ?? null,
    body_text: payload.body_text,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
    status: extras.status,
    meta_template_id: extras.metaTemplateId,
    submission_error: extras.submissionError,
    // Clear stale rejection_reason whenever we re-submit; the
    // webhook will set it again if Meta still rejects.
    rejection_reason: extras.submissionError ? null : null,
    last_submitted_at: new Date().toISOString(),
  }
}

/**
 * A retry may update only the exact local DRAFT inspected before the Meta
 * call. New variants use INSERT so a concurrent conflict can never merge a
 * failed submit over an APPROVED/PENDING template shared by the account.
 */
async function persistTemplateRow(
  supabase: SupabaseClient,
  row: ReturnType<typeof buildTemplateRow>,
  existing: ExistingTemplateRow | null,
) {
  if (!existing) {
    return supabase.from('message_templates').insert(row).select().single()
  }

  return supabase
    .from('message_templates')
    .update({ ...row, user_id: existing.user_id })
    .eq('id', existing.id)
    .eq('account_id', row.account_id)
    .eq('status', 'DRAFT')
    .is('meta_template_id', null)
    .select()
    .single()
}

/**
 * Submit a template to Meta for approval AND persist it locally.
 *
 * Auth → fetch whatsapp_config → validate → (DRY_RUN short-circuit) →
 * POST to Meta → insert a new row or update the inspected safe DRAFT with
 * status, meta_template_id, sample_values, last_submitted_at.
 *
 * When WHATSAPP_TEMPLATES_DRY_RUN=true, we skip the network call and
 * insert a row with a synthetic `dry-run-<uuid>` meta_template_id so
 * CI / local dev can exercise the full UI without a real Meta App.
 *
 * On the Meta side this is a one-way trip — a row can only be
 * submitted; editing or deleting requires hsm_id and lives in PR 4.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Resolve the caller's account_id — whatsapp_config + the
    // message_templates row are account-scoped post-multi-user.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id, account_role')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }
    if (
      !isAccountRole(profile?.account_role) ||
      !hasMinRole(profile.account_role, 'admin')
    ) {
      return NextResponse.json(
        { error: 'This action requires the admin role or higher.' },
        { status: 403 },
      )
    }

    let payload: TemplatePayload
    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    if (payload.category === 'Authentication') {
      return NextResponse.json(
        {
          error:
            'AUTHENTICATION templates are not yet supported here — create them in Meta WhatsApp Manager and use "Sync from Meta".',
        },
        { status: 400 },
      )
    }

    try {
      validateTemplatePayload(payload)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Validation failed.' },
        { status: 400 },
      )
    }

    // Template identity is shared by the account. A valid Meta-linked row
    // must go through the edit/resubmit lifecycle; treating another admin's
    // create as an upsert could erase its Meta id and approval status when
    // Meta rejects the duplicate name.
    const { data: existingData, error: existingError } = await supabase
      .from('message_templates')
      .select('id,user_id,status,meta_template_id')
      .eq('account_id', accountId)
      .eq('name', payload.name)
      .eq('language', payload.language)
      .maybeSingle()

    if (existingError) {
      return NextResponse.json(
        { error: `Could not check the existing template: ${existingError.message}` },
        { status: 500 },
      )
    }

    const existing = (existingData as ExistingTemplateRow | null) ?? null
    const safeDraftRetry =
      existing !== null &&
      existing.meta_template_id === null &&
      existing.status.toUpperCase() === 'DRAFT'

    if (existing && !safeDraftRetry) {
      return NextResponse.json(
        {
          error:
            'A template with this name and language already exists in the account. Edit or sync that template instead of creating it again.',
          existing_template_id: existing.id,
        },
        { status: 409 },
      )
    }

    const dryRun =
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'

    let metaTemplateId: string
    let metaStatus: string

    if (dryRun) {
      metaTemplateId = `dry-run-${crypto.randomUUID()}`
      metaStatus = 'PENDING'
    } else {
      const { data: config, error: configError } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', accountId)
        .single()
      if (configError || !config) {
        return NextResponse.json(
          {
            error:
              'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
          },
          { status: 400 },
        )
      }
      if (!config.waba_id) {
        return NextResponse.json(
          {
            error:
              'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
          },
          { status: 400 },
        )
      }

      const accessToken = decrypt(config.access_token)

      // Image headers need a Resumable-Upload handle (Meta rejects a
      // plain URL at creation). Derive it from header_media_url before
      // building the payload. Surfaces a 400 with an actionable message
      // (missing META_APP_ID, unreachable URL, wrong type/size).
      try {
        await ensureImageHeaderHandle(payload, accessToken)
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : 'Header image upload failed.' },
          { status: 400 },
        )
      }

      const metaPayload = buildMetaTemplatePayload(payload)
      try {
        const meta = await submitMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          payload: metaPayload,
        })
        metaTemplateId = meta.id
        metaStatus = meta.status
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta submit failed.'
        // Persist the failure so the user can retry; row stays DRAFT
        // until they fix and re-submit.
        const { error: persistError } = await persistTemplateRow(
          supabase,
          buildTemplateRow(accountId, existing?.user_id ?? user.id, payload, {
            status: 'DRAFT',
            metaTemplateId: null,
            submissionError: message,
          }),
          existing,
        )
        if (persistError) {
          console.error(
            '[templates/submit] Meta failed and the safe local draft write also failed:',
            persistError,
          )
        }
        const isRateLimit = /\b429\b/.test(message)
        return NextResponse.json(
          {
            error: isRateLimit
              ? 'Meta rate limit hit (100 template creates per hour). Try again later.'
              : message,
          },
          { status: isRateLimit ? 429 : 502 },
        )
      }
    }

    const { data: row, error: persistErr } = await persistTemplateRow(
      supabase,
      buildTemplateRow(accountId, existing?.user_id ?? user.id, payload, {
        status: normalizeStatus(metaStatus),
        metaTemplateId,
        submissionError: null,
      }),
      existing,
    )

    if (persistErr) {
      // The submit succeeded on Meta's side but we failed to persist
      // locally. That's a data-drift state — surface the meta_template_id
      // so the user can recover via "Sync from Meta".
      return NextResponse.json(
        {
          error: `Submitted to Meta but failed to save locally: ${persistErr.message}. Run "Sync from Meta" to recover.`,
          meta_template_id: metaTemplateId,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      template: row,
      dry_run: dryRun,
    })
  } catch (error) {
    console.error('Error submitting template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to submit template.',
      },
      { status: 500 },
    )
  }
}
