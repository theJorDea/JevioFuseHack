# Jevio

Локальный coding agent и оркестратор моделей. Jevio работает с Ollama, LM Studio,
vLLM и облачными OpenAI-compatible API, умеет читать и изменять проект, запускать
команды, подключать Agent Skills и раздавать задачи специализированным моделям.

Это первая рабочая версия ядра, а не готовая замена Claude Code. В ней уже есть
границы безопасности и расширяемые контракты, на которые можно наращивать TUI,
MCP, постоянные сессии и плагины.

## Что уже работает

- интерактивный CLI и одноразовые задачи;
- отдельные модели для orchestrator, architect, coder, reviewer, judge и compactor;
- динамическое делегирование в изолированный контекст;
- строгий режим architect -> coder -> reviewer;
- совет моделей для независимого планирования и ревью без конфликтующих правок;
- tools для чтения, поиска, записи, точечной замены, git diff и shell;
- symbol index и lookup_symbol для точной навигации по определениям и импортам;
- подтверждение записи и запуска команд;
- запрет выхода tools за workspace и запрет перехода через symlink;
- совместимые Agent Skills в .agents/skills/*/SKILL.md;
- OpenAI-compatible transport без внешних npm-зависимостей.

## Быстрый старт

Требуется Node.js 22.19 или новее и запущенный OpenAI-compatible сервер.

    node src/cli.ts init

Для первого запуска есть интерактивный мастер. Он проверит Node.js и Git, найдёт
Ollama/LM Studio на стандартных локальных портах, покажет модели, создаст
`jevio.config.json`, запустит `doctor` и предложит безопасную демо-задачу:

    jevio setup

Отредактируйте jevio.config.json, указав реально установленные модели, затем:

    node src/cli.ts doctor
    node src/cli.ts "исправь ошибку в обработке авторизации"

Интерактивный режим:

    node src/cli.ts

Сессия создаётся автоматически и сохраняется в читаемый Markdown. Как в Kimi
Code, последнюю сессию можно продолжить флагом, а конкретную выбрать по ID:

    node src/cli.ts --continue
    node src/cli.ts --session
    node src/cli.ts --session <id>

Команды внутри интерактивного режима:

    /new                         новая сессия
    /sessions                    список и переключение
    /session                     дополнительный алиас
    /resume [id]                 продолжить сессию
    /title <text>                переименовать
    /fork                        создать ветку диалога
    /export-md [path]            экспортировать transcript
    /compact [инструкция]        сжать текущий контекст отдельной моделью
    /compact status              показать модель, пороги и размер контекста

Файлы сессий находятся в .jevio/sessions/*.md. В контекст при resume попадает
последний ограниченный хвост сообщений, но сам Markdown сохраняет полную историю.

## Долговременная память

Project memory хранится в .jevio/MEMORY.md и автоматически добавляется в system
prompt orchestrator и всех специалистов:

    /memory
    /memory add Всегда запускать integration tests для API
    /memory clear

MEMORY.md считается пользовательской инструкцией, но по умолчанию исключён из
Git. Если правила должны быть общими для команды, их лучше переносить в
AGENTS.md или version-controlled Skill.

## Compaction

Compaction создаёт continuation summary отдельной моделью и сохраняет checkpoint
прямо в session Markdown. Исходный transcript не удаляется, но при следующем
resume Jevio начинает с последнего summary и сохранённых недавних сообщений.
Повторный compact не перечитывает всю уже сжатую историю.

Пример настройки:

    {
      "roles": {
        "compactor": {
          "provider": "ollama",
          "model": "your-small-summary-model",
          "temperature": 0.1,
          "maxTokens": 4096
        }
      },
      "agent": {
        "maxToolOutputCharacters": 12000,
        "keepRecentToolResults": 6
      },
      "compaction": {
        "auto": true,
        "contextWindowTokens": 32768,
        "reservedTokens": 4096,
        "triggerCharacters": 80000,
        "keepRecentMessages": 6,
        "maxSummaryCharacters": 16000,
        "prompt": "Preserve requirements, decisions, changed files, test results and next steps."
      }
    }

contextWindowTokens должен соответствовать модели, которая ведёт основной
диалог. reservedTokens оставляет место для следующего запроса и ответа.
triggerCharacters является запасным порогом, потому что без tokenizer конкретной
локальной модели число токенов оценивается приблизительно. Старые tool outputs
не сохраняются в диалог, а каждый новый результат tool дополнительно ограничен
maxToolOutputCharacters. При расчёте порога учитываются session history,
MEMORY.md, каталог skills и следующий пользовательский запрос.

Для модели с context window 32K можно начать с contextWindowTokens: 32768 и
reservedTokens: 4096. Для 128K-модели подставьте 131072, но не увеличивайте
reservedTokens механически: это место нужно для следующего запроса, tool calls и
ответа. Если модель начинает терять связность раньше переполнения, уменьшите
contextWindowTokens или triggerCharacters. Если compactor слабый, увеличьте
keepRecentMessages и сделайте prompt более предметным.

Полезные режимы:

    # Без оркестратора: меньше задержка и расход токенов
    node src/cli.ts --direct "добавь тест для парсера"

    # Обязательные архитектурный и ревью-проходы
    node src/cli.ts --team "переделай слой хранения данных"

    # Совет из трёх архитекторов выбирает один план, после чего пишет только один coder
    node src/cli.ts --council-plan "переделай слой сессий и не сломай compaction"

    # Три независимых ревью: безопасность, корректность и тесты; workspace не изменяется
    node src/cli.ts --council-review
    node src/cli.ts review --council

    # Не спрашивать подтверждения для write/shell
    node src/cli.ts --yes "обнови зависимости и прогони тесты"

В интерактивном режиме режим можно менять без перезапуска:

    /team          строгий architect -> coder -> reviewer
    /council-plan  3 architect -> judge -> coder -> reviewer
    /council-review 3 reviewer -> judge, без изменений workspace
    /setup         открыть настройку провайдера и модели в TUI
    /direct        быстрый запуск coder без оркестратора
    /orchestrate   стандартный orchestration mode

Orchestrator также может вызвать `suggest_mode`, когда следующий запрос выгоднее
выполнять в другом режиме. TUI показывает рекомендуемый режим, краткую причину и
варианты `Переключить`/`Оставить`. Подтвержденная смена применяется со следующей
задачи и сразу отражается в индикаторе режима под полем ввода.

Team mode передаёт текущую session history всем специалистам, поэтому
последующие задачи видят решения и итоги предыдущих шагов.

## Совет моделей

`--council-plan` предназначен для сложных изменений. Три независимых запуска
`architect` формируют варианты плана: основной, минимальный и риск-ориентированный.
Роль `judge` сопоставляет предложения с репозиторием, выбирает один итоговый план,
после чего единственный `coder` вносит изменения. Обычный `reviewer` проверяет
результат и при вердикте `FIX` запускает ограниченный конфигом цикл исправлений.

Перед запуском coder итоговый план сохраняется в `.jevio/plans/*.md` и требует
явного согласования. В TUI доступны варианты `Одобрить`, `Отклонить` и
`Другое...`: последний открывает поле для предложений, после чего architect или
judge переписывает план и снова показывает его пользователю. Для полностью
неинтерактивного запуска план можно автоматически одобрить флагом `--yes`.

`--council-review` предназначен для уже существующих изменений. Три `reviewer`
проверяют diff с фокусом на безопасность, корректность и тесты/сопровождение.
`judge` удаляет дубли и неподтверждённые замечания, группирует итоговые findings и
возвращает `PASS` или `FIX`. В этом режиме нет `coder`, поэтому он не должен
изменять workspace. Команда `jevio review --council` является короткой формой того
же запуска.

Council Review выводит `Verdict`, `Critical`, `Warnings`, `Consensus`,
`Disagreements` и `Recommended fixes`. Полный протокол трех reviewer и judge
сохраняется в Markdown-сессию. После проверки используйте `jevio fix-review`
или `/fix-review`, чтобы передать coder только подтвержденные findings judge.

Запись и точечная замена файлов показывают preview в формате unified diff до
подтверждения. Запуск shell-команд ограничивается `permissions.shellMode`:
`off`, `tests-only` (по умолчанию), `package-manager` или `full`. Режим
`package-manager` всегда повторно спрашивает подтверждение для установки или
обновления зависимостей, даже с `--yes`.

Архитекторов и ревьюеров в council-режимах можно запускать параллельно через
`agent.maxParallelReadAgents`. По умолчанию значение `1`: это безопасно для
одной локальной модели и ограниченной VRAM. Для независимых облачных endpoints
можно указать `3`; `coder` и `judge` всё равно выполняются последовательно.

    {
      "agent": { "maxParallelReadAgents": 3 }
    }

Symbol index прогревается в фоне и не задерживает первый prompt. Пока индекс
строится, lookup_symbol при первом обращении дождётся готовой карты символов.

## Установка команды

Для локальной разработки создайте npm-ссылку один раз:

    npm.cmd link
    jevio --help

На Windows используется npm.cmd, поскольку PowerShell может блокировать
исполнение npm.ps1. После публикации пакета обычная установка будет выглядеть
как npm install -g jevio. Launcher находится в bin/jevio.mjs и запускает
TypeScript CLI напрямую на Node.js 22.19+.

В корпоративных профилях PowerShell с полностью запрещёнными скриптами npm может
создать блокируемый jevio.ps1 shim. В таком случае используйте jevio.cmd либо
удалите только этот автоматически созданный shim из пользовательского npm
prefix, чтобы команда jevio выбрала jevio.cmd.

## Подключение моделей

Для Ollama достаточно указать локальный endpoint и реально установленные модели:

    {
      "defaultProvider": "ollama",
      "providers": {
        "ollama": { "baseUrl": "http://localhost:11434/v1" }
      },
      "roles": {
        "orchestrator": { "model": "your-general-model" },
        "architect": { "model": "your-reasoning-model" },
        "coder": { "model": "your-code-model" },
        "reviewer": { "model": "your-reasoning-model" },
        "judge": { "model": "your-reasoning-model" },
        "compactor": { "model": "your-small-summary-model" }
      }
    }

В `/provider` есть отдельный пресет LM Studio с endpoint `http://localhost:1234/v1`.
Выберите фактически загруженную в LM Studio модель в последнем поле формы.

Для облачного API задайте baseUrl и имя переменной с ключом:

    {
      "providers": {
        "cloud": {
          "baseUrl": "https://example.com/v1",
          "apiKeyEnv": "MY_LLM_API_KEY"
        }
      }
    }

Провайдер и модель задаются отдельно для каждой роли. Например, можно оставить
локальную модель для оркестрации, назначить сильную API-модель только `coder`, а
недорогую модель через другой провайдер для `reviewer` и `compactor`:

    {
      "defaultProvider": "ollama",
      "providers": {
        "ollama": { "baseUrl": "http://localhost:11434/v1" },
        "openrouter": {
          "baseUrl": "https://openrouter.ai/api/v1",
          "apiKeyEnv": "OPENROUTER_API_KEY",
          "defaultModel": "openai/gpt-5.2"
        },
        "nvidia-nim": {
          "baseUrl": "https://integrate.api.nvidia.com/v1",
          "apiKeyEnv": "NVIDIA_API_KEY",
          "defaultModel": "openai/gpt-oss-20b"
        },
        "openai-codex": {
          "baseUrl": "https://api.openai.com/v1",
          "transport": "responses",
          "apiKeyEnv": "OPENAI_API_KEY",
          "defaultModel": "gpt-5.2-codex"
        }
      },
      "roles": {
        "orchestrator": { "provider": "ollama", "model": "qwen3:14b" },
        "architect": { "provider": "openrouter", "model": "openai/gpt-5.2" },
        "coder": { "provider": "openai-codex", "model": "gpt-5.2-codex" },
        "reviewer": { "provider": "nvidia-nim", "model": "openai/gpt-oss-20b" }
      }
    }

В TUI используйте `/provider` для добавления пресетов OpenRouter, NVIDIA NIM или
OpenAI Codex API, затем `/roles`, чтобы назначить отдельные provider/model каждой
роли. OpenAI Codex API требует отдельный `OPENAI_API_KEY`: авторизация по
подписке ChatGPT в Fuse не используется.

Одновременно держать все модели в VRAM не требуется: вызовы выполняются
последовательно. Для небольших локальных моделей чаще лучше использовать
--direct, а ревью включать только для рискованных изменений.

Практичное распределение ролей:

- orchestrator — небольшая general-purpose модель, которая маршрутизирует задачу;
- architect — модель, хорошо работающая с анализом и ограничениями;
- coder — самая сильная code-модель, потому что она меняет файлы;
- reviewer — reasoning-модель с read-only tools;
- judge — reasoning-модель, которая выбирает план или объединяет независимые ревью;
- compactor — недорогая модель с хорошим следованием формату, без tools.

Роль compactor не должна быть обязательно такой же сильной, как coder. Её задача
не решать задачу, а точно сохранить состояние работы для следующего turn.

## Terminal UI

When Jevio runs in an interactive terminal, it uses a focused TUI rather than a plain readline prompt:

- type `/` to open the command list, keep typing to filter it (for example, `/ne`), and press `Tab` to accept a completion;
- use `Up` and `Down` to navigate command suggestions and saved-session picker entries;
- `Shift+Enter` inserts a new prompt line; `Enter` submits it;
- agent results render as Markdown, while the footer reports the current model role and tool activity;
- model turns and tool calls remain in the transcript as an activity timeline; providers that stream OpenAI-compatible `reasoning_content` (including Kimi) render a live thinking block;
- models can emit short `report_progress` plan updates to the same timeline; these are user-facing summaries, not private reasoning traces;
- `update_todo` keeps a visible task checklist for multi-step work, while `web_search` gives agents public-web titles, links, and snippets without an API key;
- when an implementation decision is materially ambiguous, Fuse can call `ask_user`, opening a keyboard-selectable picker with predefined choices and an `Other...` text answer.
- `/sessions` and `/resume` open an in-place session picker, including the session title, short ID, and last update time.
- `/provider` opens configured providers; choose `Add provider` to enter an OpenAI-compatible base URL, API key, and model ID. The key is stored in `.jevio/providers.json`, which is ignored by Git; endpoint and model configuration are stored in `jevio.config.json`. The model is applied to all Fuse roles and can later be split per role in `jevio.config.json`. `Esc` closes provider dialogs.
- The provider picker includes a `Kimi Code` preset with `https://api.kimi.com/coding/v1` and `Kimi K2.7`; enter only the API key to finish setup.

Non-interactive runs and one-shot tasks keep the simple stdout interface, so CI usage is unchanged.

## Skills

Jevio читает directory-form и flat-form skills:

    .agents/skills/security-review/
    +-- SKILL.md

В сборку Fuse уже входят `make-interfaces-feel-better`, `emil-design-eng`,
`apple-design` и `animation-vocabulary`. Они автоматически попадают в каталог
для моделей; посмотреть весь каталог можно через `jevio skills` или `/skills` в
TUI. `review-animations` также встроен, но помечен автором как ручной skill и
не навязывается модели автоматически.

Пример SKILL.md:

    ---
    name: security-review
    description: Проверка изменений авторизации и работы с секретами
    whenToUse: Когда меняется authentication, permissions или обработка токенов
    type: prompt
    ---

    # Security review

    Проверь границы доверия, утечки секретов и обход авторизации.

В system prompt попадают только имя и краткое описание. Полный документ модель
загружает через load_skill, когда он действительно нужен.

В поставку входит default skill `make-interfaces-feel-better`, адаптированный из
[jakubkrehel/make-interfaces-feel-better](https://github.com/jakubkrehel/make-interfaces-feel-better)
под лицензией MIT. Он применяется к UI-задачам и может быть переопределён skill
с тем же именем в `.agents/skills`.

## Навигация по коду

При старте Jevio строит symbol index проекта. Агент вызывает lookup_symbol вместо
полного поиска по файлам, когда ему нужно найти объявление класса, функции, типа,
метода или переменной:

    lookup_symbol("authService.validateToken")

Результат содержит путь, строку, kind, scope, сигнатуру и найденные import-связи.
Это особенно полезно для перехода от вызова к определению без расхода контекста на
весь файл.

По умолчанию backend: auto использует Universal Ctags, когда он установлен, и
встроенный индексатор в остальных случаях. Встроенный backend покрывает
TypeScript/JavaScript, Python, Go, Rust, Java/Kotlin, C/C++, C#, Ruby и PHP.
Индекс кэшируется, сбрасывается после инструментальных изменений файлов и может
быть принудительно перестроен моделью через rebuild_symbol_index.

Перед каждым новым заданием Jevio сериализует индекс в компактное дерево файлов
и объявлений. В него не попадают тела функций; файлы без символов остаются в
дереве по имени. Карта добавляется только в system prompt `orchestrator`, `architect` и `judge`,
а `coder` и `reviewer` используют точечный `lookup_symbol`.

Проверьте Universal Ctags командой `jevio doctor`. Указывайте `backend: "ctags"`
только после успешной проверки: этот режим намеренно завершится ошибкой, а не
молча перейдёт на fallback. Для переносимой установки оставляйте `auto`.
Tree-sitter пока не встраивается: для него нужно поставлять и сопровождать grammar
для каждого языка, тогда как Universal Ctags уже даёт широкий multi-language
покрытие без JavaScript native modules.

На Windows Universal Ctags можно установить командой:

    winget install -e --id UniversalCtags.Ctags

Настройки находятся в codeIndex:

    {
      "codeIndex": {
        "enabled": true,
        "backend": "auto",
        "prewarm": true,
        "maxFiles": 10000,
        "cacheTtlMs": 5000,
        "maxResults": 20,
        "mapMaxCharacters": 12000
      }
    }

## Архитектурные источники

Session workflow и изолированные subagents спроектированы по мотивам Kimi Code.
У Kimi сессии и служебные события разделены, а skills имеют metadata и ленивую
загрузку. В Jevio transcript намеренно хранится в Markdown, чтобы его можно было
проверить вручную:

    .jevio/sessions/<session-id>.md
    .jevio/MEMORY.md

Для context hygiene использованы идеи OpenCode: отдельный compaction reserve,
настраиваемый auto threshold и pruning больших tool outputs. Jevio дополнительно
проверяет, что после summary оценочный размер контекста действительно уменьшился,
и не пересказывает уже сжатую историю повторно.

Ссылки на оригинальные проекты и документацию:

- Kimi Code: https://github.com/MoonshotAI/kimi-code
- Kimi sessions: https://moonshotai.github.io/kimi-code/en/guides/sessions.html
- OpenCode: https://github.com/anomalyco/opencode
- OpenCode configuration: https://dev.opencode.ai/docs/config
- OpenCode compaction hooks: https://dev.opencode.ai/docs/plugins/#compaction-hooks

## Безопасность

По умолчанию чтение разрешено, а каждое изменение файла и shell-команда требуют
подтверждения. --yes и autoApprove* стоит включать только в доверенном
репозитории. Shell остаётся потенциально опасным даже при файловом sandbox:
команда может обращаться к сети, процессам и пользовательским данным.

Подробные контракты и дальнейшие этапы описаны в
[docs/architecture.md](docs/architecture.md).

## Проверка

    npm.cmd test
    node src/cli.ts --help

## Лицензия

MIT
