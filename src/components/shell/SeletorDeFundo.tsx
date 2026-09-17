'use client';

import { useEffect, useState } from 'react';

/**
 * Os fundos de `Orbita Vendas.dc.html`.
 *
 * O protótipo abre em `dark` **com o fundo `armazem`** — e as duas coisas não
 * são a mesma escolha. Tratar "dark" como "preto" foi o que mais afastou a
 * implementação do protótipo: sem um fundo com forma atrás dela, a janela de
 * vidro vira um retângulo escuro sobre outro retângulo escuro, e toda a
 * translucidez que sustenta o desenho deixa de existir.
 *
 * O protótipo tem um sexto, `Sua foto`, que no documento de design abre um slot
 * para arrastar uma imagem. Aqui não há de onde tirar essa imagem, e uma
 * amostra que só apaga o fundo é um controle que promete o que não entrega. Ele
 * fica de fora até existir o upload que o sustente.
 */
export const FUNDOS = [
  { id: 'armazem', rotulo: 'Armazém', amostra: 'linear-gradient(150deg,#b9c4c8,#7d8a80)' },
  { id: 'lima', rotulo: 'Lima', amostra: '#C8F441' },
  { id: 'lavanda', rotulo: 'Lavanda', amostra: '#BCA9FF' },
  { id: 'grafite', rotulo: 'Grafite', amostra: '#2A2A2E' },
] as const;

export type Fundo = (typeof FUNDOS)[number]['id'];

const PADRAO: Fundo = 'armazem';

/**
 * O fundo escolhido, num atributo do `<html>` — do mesmo jeito que o tema.
 * Nenhum componente lê o fundo diretamente; todos leem `--canvas`.
 *
 * A escolha vale para a sessão e não é guardada. Guardá-la exigiria ler o
 * armazenamento antes do primeiro desenho, e o servidor não tem esse
 * armazenamento: o HTML entregue divergiria do primeiro render no cliente por
 * causa de uma preferência de exibição. Para uma preferência opcional, não
 * vale o preço.
 */
export function useFundo(): [Fundo, (fundo: Fundo) => void] {
  const [fundo, setFundo] = useState<Fundo>(PADRAO);

  useEffect(() => {
    document.documentElement.dataset.fundo = fundo;
  }, [fundo]);

  return [fundo, setFundo];
}

/** O grupo de amostras da barra de ações, como no protótipo. */
export function SeletorDeFundo({ fundo, onEscolher }: { fundo: Fundo; onEscolher: (fundo: Fundo) => void }) {
  return (
    <fieldset
      aria-label="Fundo da tela"
      className="flex items-center"
      style={{
        gap: 5,
        padding: 5,
        borderRadius: 16,
        background: 'var(--chip)',
        border: '1px solid var(--line)',
      }}
    >
      {FUNDOS.map((opcao) => (
        <button
          key={opcao.id}
          type="button"
          title={opcao.rotulo}
          aria-label={`Fundo ${opcao.rotulo}`}
          aria-pressed={fundo === opcao.id}
          onClick={() => onEscolher(opcao.id)}
          className="cursor-pointer"
          style={{
            width: 26,
            height: 26,
            borderRadius: 9,
            background: opcao.amostra,
            boxShadow: fundo === opcao.id ? '0 0 0 2px var(--txt)' : '0 0 0 1px var(--line)',
          }}
        />
      ))}
    </fieldset>
  );
}
