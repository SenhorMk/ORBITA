-- 03_update_pedidos_status.sql
-- Este script atualiza a restrição de verificação (CHECK CONSTRAINT) da tabela pedidos
-- para permitir os novos status da esteira logística.

DO $$
DECLARE
  constraint_name text;
BEGIN
  -- Tentar descobrir o nome da constraint de check atual para a coluna status
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'pedidos'::regclass
    AND contype = 'c' 
    AND pg_get_constraintdef(oid) LIKE '%status%';

  -- Se encontrou uma constraint, remove-a
  IF constraint_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE pedidos DROP CONSTRAINT ' || constraint_name;
  END IF;
END $$;

-- Adiciona a nova constraint atualizada
ALTER TABLE pedidos ADD CONSTRAINT pedidos_status_check CHECK (
  status IN (
    'Novo', 
    'Aberto', 
    'Em Processamento', 
    'Despachado', 
    'Enviado', 
    'Entregue', 
    'Pendente', 
    'A Emitir', 
    'Atendido', 
    'Cancelado',
    'Concluído'
  )
);
