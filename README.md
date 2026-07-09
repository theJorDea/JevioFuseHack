# Jevio

Локальный coding agent и оркестратор моделей. Jevio работает с Ollama, LM Studio,
vLLM и облачными OpenAI-compatible API, умеет читать и изменять проект, запускать
команды, подключать Agent Skills и раздавать задачи специализированным моделям.

Это первая рабочая версия ядра, а не готовая замена Claude Code. В ней уже есть
границы безопасности и расширяемые контракты, на которые можно наращивать TUI,
MCP, постоянные сессии и плагины.

## Что уже работает

- интерактивный CLI и одноразовые задачи;
- отдельные модели для orchestrator, architect, coder, reviewer и compactor;
- динамическое делегирование в изолированный контекст;
- строгий режим architect -> coder -> reviewer;
- tools для чтения, поиска, записи, точечной замены, git diff и shell;
- symbol index и lookup_symbol для точной навигации по определениям и импортам;
- подтверждение записи и запуска команд;
- запрет выхода tools за workspace и запрет перехода через symlink;
- совместимые Agent Skills в .agents/skills/*/SKILL.md;
- OpenAI-compatible transport без внешних npm-зависимостей.

## Быстрый старт

Требуется Node.js 22.19 или новее и запущенный OpenAI-compatible сервер.

    node src/cli.ts init

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

    # Не спрашивать подтверждения для write/shell
    node src/cli.ts --yes "обнови зависимости и прогони тесты"

В интерактивном режиме режим можно менять без перезапуска:

    /team          строгий architect -> coder -> reviewer
    /direct        быстрый запуск coder без оркестратора
    /orchestrate   стандартный orchestration mode

Team mode передаёт текущую session history всем специалистам, поэтому
последующие задачи видят решения и итоги предыдущих шагов.

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
        "compactor": { "model": "your-small-summary-model" }
      }
    }

Для облачного API задайте baseUrl и имя переменной с ключом:

    {
      "providers": {
        "cloud": {
          "baseUrl": "https://example.com/v1",
          "apiKeyEnv": "MY_LLM_API_KEY"
        }
      }
    }

Одновременно держать все модели в VRAM не требуется: вызовы выполняются
последовательно. Для небольших локальных моделей чаще лучше использовать
--direct, а ревью включать только для рискованных изменений.

Практичное распределение ролей:

- orchestrator — небольшая general-purpose модель, которая маршрутизирует задачу;
- architect — модель, хорошо работающая с анализом и ограничениями;
- coder — самая сильная code-модель, потому что она меняет файлы;
- reviewer — reasoning-модель с read-only tools;
- compactor — недорогая модель с хорошим следованием формату, без tools.

Роль compactor не должна быть обязательно такой же сильной, как coder. Её задача
не решать задачу, а точно сохранить состояние работы для следующего turn.

## Terminal UI

When Jevio runs in an interactive terminal, it uses a focused TUI rather than a plain readline prompt:

- type `/` to open the command list, keep typing to filter it (for example, `/ne`), and press `Tab` to accept a completion;
- use `Up` and `Down` to navigate command suggestions and saved-session picker entries;
- `Shift+Enter` inserts a new prompt line; `Enter` submits it;
- agent results render as Markdown, while the footer reports the current model role and tool activity;
- `/sessions` and `/resume` open an in-place session picker, including the session title, short ID, and last update time.

Non-interactive runs and one-shot tasks keep the simple stdout interface, so CI usage is unchanged.

## Skills

Jevio читает directory-form и flat-form skills:

    .agents/skills/security-review/
    +-- SKILL.md

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
дереве по имени. Карта добавляется только в system prompt `orchestrator` и
`architect`, а `coder` и `reviewer` используют точечный `lookup_symbol`.

Проверьте Universal Ctags командой `jevio doctor`. Указывайте `backend: "ctags"`
только после успешной проверки: этот режим намеренно завершится ошибкой, а не
молча перейдёт на fallback. Для переносимой установки оставляйте `auto`.
Tree-sitter пока не встраивается: для него нужно поставлять и сопровождать grammar
для каждого языка, тогда как Universal Ctags уже даёт широкий multi-language
покрытие без JavaScript native modules.

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
