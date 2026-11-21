# Публичная внешняя задача: slash и пути с Unicode

Источник: [sindresorhus/slash, изменение #20](https://github.com/sindresorhus/slash/pull/20). До изменения библиотека оставляла обычные пути с не-ASCII символами без нормализации. Это было задокументированное ограничение; upstream снял его, сохранив исключение для extended-length путей (`\\?\`).

- `before.js` — полный [index.js родительского коммита b5cdd12](https://github.com/sindresorhus/slash/blob/b5cdd12272f94cfc37c01ac9c2b4e22973e258e5/index.js).
- `after.js` — полный [index.js коммита b83ed2a](https://github.com/sindresorhus/slash/blob/b83ed2a93fdeb869e603be76dc7fe8593554502c/index.js).
- Оба файла без изменений, лицензия — [MIT](LICENSE). `entry: "default"` соответствует реальному ESM-экспорту: адаптер и обёртка не нужны. `case.json` закрепляет SHA-256 файлов; `naive.js` — отдельное намеренно неполное решение Fuse, не upstream-код.

Из корня checkout после `npm ci` (Node ≥22.19):

```sh
npm run eval:team -- qualify examples/team-cases/slash-unicode/case.json
npm run eval:team -- verify examples/team-cases/slash-unicode/case.json examples/team-cases/slash-unicode/after.js
npm run eval:team -- verify examples/team-cases/slash-unicode/case.json examples/team-cases/slash-unicode/naive.js
```

### Ожидаемый результат

| Версия | Обычные пути с Unicode | Контрольные примеры |
|---|---:|---:|
| `before.js` — до изменения | 0 из 2 | 3 из 3 |
| `after.js` — исправление авторов | 2 из 2 | 3 из 3 |
| `naive.js` — замена всех обратных косых черт | 2 из 2 | 2 из 3 |

Первые две команды возвращают код **0**. У третьей **ожидается код 1**: `target: PASS`, но `control: FAIL`. Наивное решение портит специальный путь Windows с префиксом `\\?\`. Обычный сетевой путь (UNC) и строку с уже нормализованными разделителями оно обрабатывает правильно.

Это офлайн-проверка на публичном примере, а не сравнение моделей. Чтобы повторить её на своём коде, перейдите к [инструкции для команды](../../../docs/team-evaluation.md).
