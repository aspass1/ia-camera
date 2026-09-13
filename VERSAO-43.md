# LinhaCount 43 — atualização experimental

Inclui a leitura lateral no enquadramento amplo, integração Python e reanálise
do vídeo quando o enquadramento muda. A confirmação ampla aguarda cerca de
1,5 segundo depois da retirada para observar o destino.

Resultados de desenvolvimento: vídeo amplo com descartes: 9 boas, 2 resíduos
e 1 ocorrência não classificada; vídeo amplo sem descartes: 10 boas e 0 resíduos;
regressão original: 14 boas e 3 resíduos. Estes vídeos foram usados no ajuste,
portanto os resultados não comprovam precisão independente nem ao vivo.

O modo amplo continua limitado a testes, sem gravar produção. Não foram
incluídos vídeos, banco de produção, credenciais ou ambiente Python instalado.

Execute INSTALAR IA.cmd se necessário e INICIAR LINHACOUNT.cmd no computador.
Abra http://127.0.0.1:8766/linhacount/index.html?v=43 e escolha o enquadramento
adequado antes de testar. A implantação estática da Vercel não executa o
servidor Python; publicar o repositório não basta para habilitar a contagem online.
