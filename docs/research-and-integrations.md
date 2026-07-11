# Аудит Cognee и план развития Jevio

Дата исследования: 11 июля 2026 года.

Этот документ отделяет подтверждённое текущее состояние от идей. Приоритеты
расставлены для хакатона: сначала доказуемая надёжность памяти и сильная
демонстрация, затем расширение экосистемы.

## Краткий вывод

Интеграция Cognee реализована корректно на уровне REST-контракта и архитектуры:

- используются актуальные операции `remember`, `recall`, `improve` и удаление
  dataset через `/api/v1/datasets/{id}`;
- Cloud-аутентификация идёт через `X-Api-Key`, self-hosted Bearer поддерживается;
- память ограничена dataset проекта, размер recall и remember ограничен;
- timeout или ошибка Cognee не ломают основную coding-сессию;
- извлечённая память помечается как недоверенный исторический контекст;
- есть unit-тесты и опциональный тест полного Cloud lifecycle.

Офлайн-набор после синхронизации с `origin/main`: **76/76 тестов проходят**,
`npm run check` проходит. Это подтверждает поведение адаптера на mock-ответах.
Полную совместимость с конкретным tenant Cognee подтверждает только
`npm run test:cloud` с настоящими `COGNEE_BASE_URL` и `COGNEE_API_KEY`.

## Что в Cognee уже сделано хорошо

| Область | Реализация | Оценка |
| --- | --- | --- |
| Ingestion | Multipart `POST /api/v1/remember` с Markdown-файлом | Корректно |
| Retrieval | `POST /api/v1/recall`, dataset scope, `top_k`, bounded context | Корректно |
| Совместимость | Fallback с `recall` на legacy `search`, с `improve` на `memify` | Полезно для разных версий |
| Изоляция | Автоматическое имя dataset из workspace и hash пути | Хорошо, если не переопределено общим именем |
| Удаление | Поиск dataset по имени и удаление только его UUID | Корректно и безопаснее deprecated delete API |
| Деградация | Ошибка памяти превращается в warning | Правильно для coding-агента |
| Секреты | Имена env-переменных в конфиге, ключи не хардкодятся | Корректно |
| Проверка | Unit-тесты плюс opt-in Cloud integration test | Хорошая база |

Контракт совпадает с актуальной [документацией Cognee API](https://docs.cognee.ai/api-reference/introduction),
[Remember](https://docs.cognee.ai/api-reference/remember/remember),
[Recall](https://docs.cognee.ai/api-reference/recall/recall),
[Improve](https://docs.cognee.ai/api-reference/improve/improve) и
[Dataset Management](https://docs.cognee.ai/cognee-cloud/functionality/dataset-management).

## Найденные ограничения

### P0 — session-aware память фактически не используется

`src/cli.ts` передаёт ID активной сессии в `CogneeMemory.remember`, но
`src/memory.ts` принимает его как `_sessionId` и не добавляет `session_id` в
multipart. Команда `/memory improve` также вызывается без списка session IDs.
При recall одновременно передаются `session_id` и `datasets`; согласно Cognee,
наличие dataset направляет запрос в постоянный граф, а не в session-first cache.

Текущая постоянная память работает, но Jevio не получает быстрый short-term
recall, перенос полезных Q&A из сессии в граф и feedback-aware improvement.

Рекомендуемое изменение:

1. Добавить режимы `permanent`, `session` и `hybrid` в конфигурацию памяти.
2. В `hybrid` передавать `session_id` в `remember` и сохранять активные session IDs.
3. `/memory improve` должен передавать текущую или выбранные сессии.
4. Для текущего диалога сначала делать session recall без dataset, затем отдельный
   graph recall с dataset и объединять результаты с дедупликацией.
5. Покрыть этот путь реальным Cloud-тестом, а не только mock-тестом метода.

Основание: [Cognee Sessions and Caching](https://docs.cognee.ai/core-concepts/sessions-and-caching),
[Recall](https://docs.cognee.ai/core-concepts/main-operations/recall) и
[Improve](https://docs.cognee.ai/core-concepts/main-operations/improve).

### P0 — защита от устаревшей и отравленной памяти

Недоверенная маркировка при recall защищает prompt hierarchy, но не гарантирует
качество самих фактов. Сейчас успешный финальный ответ можно записать в граф без
подтверждения тестами, commit SHA, источника и срока актуальности. Ошибка модели
или инструкция из README может стать долговременным ложным воспоминанием.

Минимальный безопасный формат записи:

```json
{
  "kind": "completed_task",
  "project": "stable-project-id",
  "session": "session-id",
  "commit": "git-sha-or-null",
  "request": "краткая исходная задача",
  "result": "проверенный итог",
  "files": ["изменённые пути"],
  "verification": ["npm test: pass"],
  "createdAt": "ISO-8601",
  "supersedes": []
}
```

Записывать следует подтверждённый итог, а не свободный ответ модели. Для решений
нужны `supersedes`, удаление/понижение веса устаревших записей и команда просмотра
источника памяти. Риск persistent memory poisoning отдельно выделен в
[OWASP Top 10 for Agentic Applications](https://genai.owasp.org/).

### P0 — уникальный dataset по умолчанию

Не следует задавать одинаковый `dataset: "agent_sessions"` в копируемом конфиге:
несколько проектов начнут делить граф. Без поля `dataset` уже работает безопасное
автоматическое имя `jevio-<project>-<workspace-hash>`. Для переносимости между
разными путями лучше позже перейти от hash абсолютного пути к стабильному ID,
сохранённому в `.jevio/project.json`.

### P1 — наблюдаемость и повторные попытки

Сейчас status намеренно скрывает часть ошибок dataset API, а retry покрывает
только известную гонку создания dataset. Стоит добавить:

- retry с jitter для `429`, `502`, `503`, `504` и поддержку `Retry-After`;
- отдельные latency/error counters для remember, recall, improve и forget;
- correlation ID: session → model call → tool call → Cognee request;
- source, score, dataset и pipeline run ID в debug event, без содержимого секретов;
- OpenTelemetry spans по GenAI semantic conventions.

OpenTelemetry уже определяет соглашения для
[GenAI agent spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/).
Это позволит подключить Jaeger, Grafana Tempo, Honeycomb или другой OTLP backend
без зависимости core от конкретного продукта.

### P1 — provenance результатов recall

`responseStrings()` превращает разные ответы Cognee в строки и теряет source,
score, QA ID и metadata. Для режима объяснимости нужен тип `RetrievedMemoryItem`
с текстом, источником, dataset, session, score и timestamp. В prompt можно оставить
только текст, но `/memory explain` должен показывать, почему фрагмент попал в
контекст и откуда он взят.

## Рекомендуемые интеграции

### 1. MCP-клиент — максимальная отдача для хакатона

Model Context Protocol даёт единый способ подключать GitHub, issue trackers,
документацию, базы данных и observability tools. Jevio уже имеет внутренние tools
и permission gate, поэтому MCP-инструменты нужно преобразовывать в тот же контракт,
а не давать им обходной путь.

Минимальная реализация:

- transports: `stdio` и Streamable HTTP;
- discovery `tools/list`, namespaces `server.tool`;
- JSON Schema validation входа и структурированного результата;
- allowlist серверов и tool names;
- read/write classification и подтверждение на каждый side effect;
- timeout, output limit, redaction и audit event;
- недоверенные annotations/описания серверов не должны менять policy.

Это соответствует актуальной [спецификации MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic)
и требованиям к [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
Для демонстрации можно подключить официальный Cognee MCP: он предоставляет
операции памяти и готовые конфигурации для coding clients
([Cognee MCP integrations](https://docs.cognee.ai/cognee-mcp/integrations)).

### 2. ACP — интеграция с редакторами

Agent Client Protocol стандартизирует соединение coding-агента с редактором.
Для Jevio это естественнее, чем писать отдельное расширение под каждый IDE:
сессии, streaming, tool calls и permission requests уже существуют.

Первый вертикальный срез: ACP server поверх session host, открытие workspace,
stream ответа, запрос разрешения и публикация diff. Официальный проект содержит
TypeScript SDK: [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol).

### 3. Улучшенный code intelligence: Tree-sitter, затем SCIP

Текущий regex/Ctags индекс быстрый, но плохо понимает неполный код, scope и ссылки.
Практичный путь:

1. Tree-sitter как встроенный кроссплатформенный AST backend для популярных языков.
2. Сохранить нынешний fallback, чтобы установка не стала тяжёлой.
3. Позже импортировать SCIP indexes для точных definitions/references в больших
   polyglot-репозиториях.

[Tree-sitter](https://tree-sitter.github.io/) рассчитан на быстрое инкрементальное
построение дерева и устойчив к синтаксическим ошибкам.
[SCIP](https://github.com/sourcegraph/scip) — language-agnostic протокол индекса
для definitions, references и implementations.

### 4. OpenTelemetry

Добавить опциональный OTLP exporter и spans:

```text
jevio.task
  ├─ gen_ai.invoke_agent (orchestrator)
  ├─ jevio.memory.recall
  ├─ gen_ai.invoke_agent (coder)
  ├─ jevio.tool.call
  └─ jevio.memory.remember
```

По умолчанию payload prompts, содержимое файлов и memory text не экспортировать;
только opt-in. Это даст измеримые latency, token usage, долю успешных tool calls,
recall hit rate и причины fallback.

### 5. Изолированное выполнение кода

Локальный permission gate контролирует намерение, но `shell` всё равно работает на
машине пользователя. Для недоверенных репозиториев нужен опциональный execution
backend с единым интерфейсом: `local`, `docker`, `remote-sandbox`.

- Docker/Podman — лучший local-first вариант.
- [E2B](https://e2b.dev/docs) — быстрые изолированные cloud sandboxes и JS SDK.
- [Daytona](https://www.daytona.io/docs/en/) — отдельные kernel/filesystem/network
  и snapshots; полезно для долгих агентных задач.

Это не должно заменять permission gate: sandbox ограничивает последствия, а gate
выражает согласие пользователя.

### 6. A2A — только после MCP и ACP

A2A подходит для связи Jevio с внешними агентами и публикации Agent Card, но
внутренние роли уже эффективно работают через локальный orchestrator. Поэтому A2A
не даст хакатону столько пользы, сколько MCP, ACP и observability. Вернуться к нему
стоит при появлении удалённых команд агентов. Спецификация:
[Agent2Agent Protocol](https://google-a2a.github.io/A2A/specification/).

## Оценка качества вместо субъективной демонстрации

Нужен небольшой собственный benchmark из 20–30 задач:

- повторное использование решения из прошлой сессии;
- конфликт старой памяти с текущим кодом;
- отсутствие релевантной памяти;
- memory poisoning в документе;
- переименование API после сохранённого решения;
- выбор direct/team/council режима;
- исправление ошибки с запуском тестов.

Для каждого сценария сравнивать `Cognee off` и `Cognee on`:

- task success и test pass;
- recall precision@k и долю задач с полезной памятью;
- количество токенов, model calls и tool calls;
- время до первого изменения и полное время;
- stale-memory error rate;
- число запросов разрешения.

Формат harness можно вдохновить реальными issue/patch задачами из
[SWE-bench](https://github.com/SWE-bench/SWE-bench), но для хакатона не нужно
поднимать полный тяжёлый набор. Важнее воспроизводимый локальный mini-benchmark,
который проверяет уникальную гипотезу Jevio: память улучшает следующую сессию и не
перекрывает актуальное состояние репозитория.

## План реализации

| Приоритет | Работа | Проверяемый результат |
| --- | --- | --- |
| P0 | Настоящий Cognee Cloud lifecycle в CI/manual release check | remember, readiness, recall, improve, cleanup проходят на временном dataset |
| P0 | Hybrid session + graph memory | новая сессия recall-ит short-term данные и переносит их в graph через improve |
| P0 | Структурированные записи с commit/verification/provenance | `/memory explain` показывает источник; stale запись может быть superseded |
| P0 | Уникальный стабильный project ID | два workspace не смешивают память, перенос проекта сохраняет dataset |
| P1 | MCP client с permission mapping | GitHub/read-only MCP tool вызывается; write tool требует подтверждения |
| P1 | OpenTelemetry | один task отображается единым trace без секретов и file contents |
| P1 | Mini memory benchmark | отчёт Cognee on/off воспроизводится одной командой |
| P1 | Tree-sitter backend | symbol lookup точнее на TS/Python и сохраняет fallback |
| P2 | ACP server | Jevio работает хотя бы в одном совместимом редакторе |
| P2 | Docker/E2B/Daytona backend | тесты недоверенного проекта выполняются вне host |
| P3 | A2A endpoint | внешний агент обнаруживает Jevio и делегирует ограниченную задачу |

## Что показать жюри

1. Выполнить задачу, где Jevio принимает архитектурное решение и сохраняет
   проверенный итог в Cognee.
2. Открыть новую сессию и показать источник recall, session ID, dataset и commit.
3. Изменить код так, чтобы старая память стала неактуальной, и показать приоритет
   текущего repository state.
4. Запустить `/memory improve`, затем повторить вопрос и сравнить retrieval.
5. Показать trace или компактный отчёт: latency, token/tool calls, memory hit.
6. Завершить `/memory clear` и доказать, что удалился только dataset проекта.

Так демонстрация показывает не только наличие интеграции, но и контролируемую,
измеримую и безопасную память coding-агента.
