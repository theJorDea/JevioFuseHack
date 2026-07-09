# Архитектура Jevio

## Компоненты

    CLI / будущий TUI, ACP
            |
            v
root orchestrator ----------------------+
            |                               |
            v                               v
    isolated architect/coder/reviewer   session host (next)
            |
            v
    stateless agent loop
       |          |             |
    provider    tools       skills catalog
       |          |             |
Ollama/API  symbol index + workspace + permission gate

Session host сохраняет каждую пару User/Assistant в
.jevio/sessions/<session-id>.md. Служебные tool calls туда не попадают. Это
оставляет transcript читаемым и ограничивает загрязнение контекста при resume.
Команды /new, /sessions, /resume, /title, /fork и /export-md повторяют основной
session workflow Kimi Code.

.jevio/MEMORY.md содержит долговременные пользовательские инструкции проекта.
Он загружается отдельно от session history и передаётся всем ролям.

src/compaction.ts оценивает размер истории, вызывает отдельную роль compactor и
строит новый model-visible context из summary и нескольких последних сообщений.
Checkpoint дописывается в Markdown без удаления исходного transcript. Порог
учитывает contextWindowTokens, reservedTokens и запасной лимит символов.

src/agent.ts владеет одним модельным turn loop: запрос, tool calls, результаты
tools и условие завершения. Он ничего не знает о конкретном UI.

src/orchestrator.ts реализует воспроизводимый team pipeline. Динамический путь
реализован через delegate_agent: root agent сам решает, какой изолированный
контекст оправдывает дополнительный модельный вызов.

При team mode host передаёт compacted session history всем specialist agents.
Промежуточные tool traces по-прежнему остаются изолированными: между ролями
передаются только история пользователя и итоговые отчёты предыдущих задач.

src/provider переводит единый внутренний контракт в протокол провайдера.
Сейчас реализован OpenAI-compatible Chat Completions. Следующие адаптеры не
должны менять agent loop.

src/tools.ts содержит schema и выполнение built-in tools. Проверка workspace и
permission gate находятся на стороне host, а не модели.

src/skills.ts сканирует metadata и лениво загружает инструкции. Поддерживаемый
формат совместим с открытым .agents/skills соглашением.

src/symbol-index.ts строит code map с определениями и import-связями. Backend
auto использует Universal Ctags, если он доступен, иначе встроенный индексатор.
lookup_symbol возвращает модели путь, строку, kind, scope, сигнатуру и import
references без передачи полного дерева или содержимого файлов.

Перед task host сериализует symbol index в ограниченную по размеру карту
репозитория: дерево файлов и объявления без тел функций. Эта карта входит только
в system prompt orchestrator и architect; coder и reviewer получают детали через
lookup_symbol, чтобы не тратить их контекст на обзор всего проекта.

## Инварианты

1. Модель не является границей безопасности.
2. Subagent получает самодостаточную задачу, но не историю root agent.
3. Subagent не может создавать вложенных subagents.
4. Tool call всегда превращается в tool result, включая ошибку или отказ.
5. Файл нельзя читать или менять за пределами workspace либо через symlink.
6. Архитектурный agent не получает write и shell tools.
7. Провайдер, UI и постоянное хранение не должны импортироваться в tools.
8. Символьный индекс является read-only кэшем и инвалидируется после tool edits.

## Что взято из опыта Kimi Code

Архитектурно полезны четыре решения: stateless loop отделён от session host;
subagents работают в изолированном контексте; skills обнаруживаются по metadata
и загружаются лениво; side effects проходят permission gate. Формат skills
совместим на уровне основных frontmatter-полей. Исходный код Kimi Code в Jevio
не копировался.

Из OpenCode взяты две идеи для context hygiene: резерв токенов до фактического
переполнения context window и отдельный лимит больших tool outputs. В отличие от
OpenCode, Jevio не возвращает старые tool outputs в resumed history и при
повторной компактизации начинает с последнего checkpoint. Внутри длинного agent
turn сохраняется только настраиваемое число последних полных tool results;
предыдущие заменяются короткими маркерами без удаления tool_call_id.

## Следующие этапы

### Этап 2: надёжные длинные сессии

- дополнительный debug event stream model/tool/permission;
- точный token accounting через tokenizer выбранной модели;
- отмена через AbortSignal, retry и backoff;
- lifecycle hooks PreToolUse, PostToolUse, Stop.

### Этап 3: экосистема

- MCP client и динамические tool schemas;
- плагины из skills, tools и hooks;
- user/project/extra уровни skills с явным trust;
- Anthropic Messages и Responses API adapters;
- capability registry: tool calling, vision, context size, reasoning.

### Этап 4: интерфейсы и параллелизм

- TUI со streaming и сворачиваемыми tool results;
- ACP adapter для редакторов;
- scheduler независимых read-only subagents;
- фоновые задачи с ограничением concurrency;
- benchmark-набор реальных coding tasks для сравнения маршрутизации моделей.
