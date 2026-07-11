'use client';

// ============================================================
// ApiKeysSettings — Settings → API keys
//
// Manage the credentials that authenticate the public REST API
// (`/api/v1/*`). Any member sees the roster (read-only); admin+ can
// mint and revoke (gated by <RequireRole min="admin"> here and the
// admin-only API routes + RLS on the server).
//
// One-time reveal: a freshly-minted key's plaintext is shown ONCE in
// the creation dialog. After it closes, only the prefix remains —
// the server stores just the hash. The UI states this explicitly so
// the absence of a "copy again" button reads as intentional, not a
// bug (same lesson as the invite-link flow).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import {
  API_SCOPES,
  SCOPE_DESCRIPTIONS,
  type ApiScope,
} from '@/lib/api-keys/scopes';
import { SettingsPanelHead } from './settings-panel-head';

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function keyStatus(k: ApiKey): 'active' | 'revoked' | 'expired' {
  if (k.revoked_at) return 'revoked';
  if (k.expires_at && new Date(k.expires_at).getTime() <= Date.now())
    return 'expired';
  return 'active';
}

export function ApiKeysSettings() {
  const { canEditSettings } = useAuth();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/api-keys', { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'No se pudieron cargar las claves de API');
        return;
      }
      const data = (await res.json()) as { keys: ApiKey[] };
      setKeys(data.keys);
    } catch (err) {
      console.error('[ApiKeysSettings] load error:', err);
      toast.error('No se pudo conectar con el servidor');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRevoke(key: ApiKey) {
    setRevoking(key.id);
    try {
      const res = await fetch(`/api/account/api-keys/${key.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'No se pudo revocar la clave');
        return;
      }
      toast.success(`Se revocó "${key.name}"`);
      // Reflect the revoke locally without a refetch.
      setKeys((prev) =>
        prev.map((k) =>
          k.id === key.id ? { ...k, revoked_at: new Date().toISOString() } : k
        )
      );
    } catch (err) {
      console.error('[ApiKeysSettings] revoke error:', err);
      toast.error('No se pudo conectar con el servidor');
    } finally {
      setRevoking(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="Claves de API"
        description={
          <>
            Las claves autentican la API REST pública (
            <code className="text-xs">/api/v1</code>) para que construyas tus
            propias automatizaciones. Envíalas como{' '}
            <code className="text-xs">Authorization: Bearer &lt;key&gt;</code>.
          </>
        }
        action={
          <RequireRole min="admin">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              Nueva clave de API
            </Button>
          </RequireRole>
        }
      />

      {keys.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <KeyRound className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">
              Aún no hay claves de API.
            </p>
            {canEditSettings ? (
              <p className="text-muted-foreground mt-1 text-xs">
                Haz clic en <span className="text-foreground">Nueva clave de API</span> para
                crear una.
              </p>
            ) : (
              <p className="text-muted-foreground mt-1 text-xs">
                Pídele a un administrador que cree una.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {keys.map((k) => {
                const status = keyStatus(k);
                const inactive = status !== 'active';
                return (
                  <li
                    key={k.id}
                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`truncate text-sm font-medium ${
                            inactive
                              ? 'text-muted-foreground line-through'
                              : 'text-foreground'
                          }`}
                        >
                          {k.name}
                        </span>
                        {status === 'revoked' && (
                          <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                            Revocada
                          </Badge>
                        )}
                        {status === 'expired' && (
                          <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                            Expirada
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-0.5 font-mono text-xs">
                        {k.key_prefix}…
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {k.scopes.length === 0 ? (
                          <span className="text-muted-foreground text-xs">
                            Sin permisos
                          </span>
                        ) : (
                          k.scopes.map((s) => (
                            <Badge
                              key={s}
                              className="border-border bg-muted text-muted-foreground text-[10px]"
                            >
                              {s}
                            </Badge>
                          ))
                        )}
                      </div>
                      <p className="text-muted-foreground mt-1.5 text-xs">
                        Creada el {fmtDate(k.created_at)}
                        {' · '}
                        {k.last_used_at
                          ? `usada por última vez ${fmtDate(k.last_used_at)}`
                          : 'nunca usada'}
                        {k.expires_at && status !== 'expired'
                          ? ` · expira ${fmtDate(k.expires_at)}`
                          : ''}
                      </p>
                    </div>

                    {status === 'active' && (
                      <RequireRole min="admin">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRevoke(k)}
                          disabled={revoking === k.id}
                          className="self-start border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200 sm:self-auto"
                        >
                          {revoking === k.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Trash2 className="size-4" />
                          )}
                          Revocar
                        </Button>
                      </RequireRole>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={load}
      />
    </section>
  );
}

// ------------------------------------------------------------
// Create dialog — form → one-time plaintext reveal.
// ------------------------------------------------------------

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Once set, we switch from the form to the reveal view.
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  function reset() {
    setName('');
    setScopes([]);
    setSubmitting(false);
    setCreatedKey(null);
  }

  function toggleScope(scope: ApiScope, checked: boolean) {
    setScopes((prev) =>
      checked ? [...prev, scope] : prev.filter((s) => s !== scope)
    );
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Dale un nombre a la clave');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, scopes }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'No se pudo crear la clave');
        return;
      }
      setCreatedKey(payload.plaintext as string);
      onCreated();
    } catch (err) {
      console.error('[CreateKeyDialog] create error:', err);
      toast.error('No se pudo conectar con el servidor');
    } finally {
      setSubmitting(false);
    }
  }

  async function copyKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      toast.success('Clave de API copiada');
    } catch {
      toast.error('Error al copiar — selecciona y copia manualmente');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="border-border bg-popover sm:max-w-md">
        {createdKey ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                Copia tu clave de API
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Esta es la única vez que se muestra la clave completa. Guárdala
                en un lugar seguro — si la pierdes, revócala y crea una nueva.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-1.5">
              <Label className="text-muted-foreground">Clave de API</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={createdKey}
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button type="button" variant="outline" onClick={copyKey}>
                  <Copy className="size-4" />
                  Copiar
                </Button>
              </div>
            </div>

            <DialogFooter>
              <Button
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                Listo
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                Nueva clave de API
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Nómbrala según la integración que la usará, y otórgale solo los
                permisos que necesita.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="api-key-name" className="text-muted-foreground">
                  Nombre
                </Label>
                <Input
                  id="api-key-name"
                  value={name}
                  maxLength={80}
                  placeholder="p. ej. Automatización de Zapier"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">Permisos</Label>
                <div className="border-border space-y-2 rounded-md border p-3">
                  {API_SCOPES.map((scope) => (
                    <label
                      key={scope}
                      className="flex cursor-pointer items-start gap-2.5"
                    >
                      <Checkbox
                        checked={scopes.includes(scope)}
                        onCheckedChange={(checked) =>
                          toggleScope(scope, checked === true)
                        }
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="text-foreground block font-mono text-xs">
                          {scope}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {SCOPE_DESCRIPTIONS[scope]}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="text-muted-foreground text-xs">
                  Una clave sin permisos aún puede llamar a{' '}
                  <code className="text-[11px]">GET /api/v1/me</code> para
                  verificar que funciona.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                Cancelar
              </Button>
              <Button onClick={handleCreate} disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Creando…
                  </>
                ) : (
                  'Crear clave'
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
