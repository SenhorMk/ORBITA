-- Restaura apenas a execução transitiva exigida pelos gatilhos e RPCs invoker
-- das migrations 76 e 77. As tabelas, os chamadores e as políticas ficam intactos.
begin;

revoke execute on function
    public.fn_travar_bling_id_de_contato(uuid, text),
    public.fn_travar_bling_id_de_produto(uuid, text),
    public.fn_marcar_contato_no_ciclo(uuid, timestamptz, timestamptz),
    public.fn_exigir_administrador_da_organizacao(uuid, uuid)
from public, anon, authenticated;

grant execute on function
    public.fn_travar_bling_id_de_contato(uuid, text),
    public.fn_travar_bling_id_de_produto(uuid, text),
    public.fn_marcar_contato_no_ciclo(uuid, timestamptz, timestamptz),
    public.fn_exigir_administrador_da_organizacao(uuid, uuid)
to service_role;

commit;
