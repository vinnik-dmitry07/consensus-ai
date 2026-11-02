---
name: Stage 1 response tabs
overview: Show only non-empty completed Stage 1 answers as tabs, preserve manual selection, reuse existing failure/skip notes and safe reasons, and separate answer count from completed slots.
todos:
  - id: stage1-state
    content: Reuse and verify existing Stage 1 accounting and skipped data; test production transitions, honor terminal payloads, and pass skips/isRunning through ChatInterface.jsx.
    status: completed
  - id: answer-tabs
    content: Render non-empty answers as tabs; preserve manual selection until retry and distinguish answer count from completion progress, including stopped and zero-total states.
    status: completed
  - id: diagnostic-notes
    content: Show safe failure/skip notes with existing saved history and short reasons; remove obsolete Stage 1 styles and confirmed debug instrumentation.
    status: completed
  - id: verify-stage1
    content: Add focused production-state and SSR regression tests; verify selection and retry in the browser, then run build and scoped lint.
    status: completed
isProject: false
---

# Stage 1 response tabs

Основание ревью: [consensus-ai master cb266a15](https://github.com/vinnik-dmitry07/consensus-ai/tree/cb266a15a40703cddd3a1d0b29adabf4fe29de5c). На 21 октября 2026 публичный master остаётся на этом SHA. Сведения о более новых локальных изменениях ниже взяты из рабочей копии этого репозитория. Перед реализацией ещё раз подтвердить их по diff.

**Четырёх todo достаточно.** Состав заменён: доставка skip-событий и проверки входят в план; смена подписи progress входит в состояние и рендер; удаление debug/CSS входит в заметки.

Перед реализацией сверить HEAD и локальный diff [App.jsx](frontend/src/App.jsx), [ChatInterface.jsx](frontend/src/components/ChatInterface.jsx), [Stage1.jsx](frontend/src/components/Stage1.jsx), [engine.js](frontend/src/engine/browser/engine.js), [openrouter.js](frontend/src/engine/browser/openrouter.js). Не переносить snapshot `cb266a15` поверх локальных изменений.

## Рабочая копия, а не чистый master

На `cb266a15` skip отбрасывается, `completed` растёт, `total` не уменьшается, `ChatInterface` не передаёт skips, а `skippedResult()` отдаёт общее `Skipped`. В этой рабочей копии это уже не так. Переиспользовать, не откатывать:

- `stage1_skipped` уже есть в [App.jsx](frontend/src/App.jsx), передаётся из [ChatInterface.jsx](frontend/src/components/ChatInterface.jsx) и пишется движком в финальный payload.
- Новый skip не увеличивает `completed` и уменьшает `total` до нижней границы 0. Replay с `existing` не увеличивает `completed`.
- [openrouter.js](frontend/src/engine/browser/openrouter.js) уже кладёт в `error.message` короткие причины: `Only available on agentic harnesses`, `Temporarily rate-limited upstream`, `Cooling down after an upstream rate limit`, `OpenRouter will not serve this model`, иначе `Skipped`. Причины не выдумывать, если строки нет.
- Debug `fetch` на `127.0.0.1:7417` есть в `App.jsx` и `Stage1.jsx`. `.tab-skipped` есть в [Stage1.css](frontend/src/components/Stage1.css). Их удалить, потому что они найдены здесь. На `cb266a15` их нет, и это не повод оставлять локальные вставки.
- Движок уже сохраняет `stage1_skipped` в IndexedDB. Использовать эти существующие данные при загрузке чата и показывать сохранённые skip notes. Новую схему хранения или миграцию не добавлять. Для старых сообщений без поля использовать `[]`. Failure notes по-прежнему живут в `stage1_failures`.

## Что исправлено относительно первого черновика

- Одного удаления `error.detail` недостаточно: `httpErrorFromText` для большинства HTTP-ошибок дописывает provider body в `error.message`.
- Точную skip-причину нельзя восстановить по model id или synthetic 403. Показывать только уже пришедшее короткое безопасное сообщение.
- Наличие `progress` не значит, что поток ещё идёт. Generic error выключает loading и может оставить progress.
- Старые записи могут иметь пустой, пробельный или нестроковый `response`. Такие записи не являются вкладками.

## Контракт результата

- **R1:** вкладки содержат только завершённые ответы с непустым строковым текстом. Отдельные samples одной модели остаются отдельными вкладками.
- **R2:** без ручного выбора открыт последний доступный ответ. Клик фиксирует выбранный sample до нового запуска Stage 1.
- **R3:** failures и skips показываются краткими текстовыми заметками, в том числе при нуле ответов. Provider JSON не выводится.
- **R4:** число ответов равно числу вкладок. Завершённые слоты и ответы считаются отдельно. Skips исключаются из total. Replay не удваивает completed. `total = 0` безопасен.
- **R5:** failure и skip notes используют уже существующие данные текущей рабочей копии и доступны после reload, если движок их сохранил. Начало нового Stage 1 очищает прежние skips в состоянии панели; новый набор формируется из событий и финального payload этой попытки. Отсутствие поля в старых сообщениях означает `[]`.
- **R6:** сохраняются исходный порядок Stage 1 для Stage 2, Markdown и Copy, классификация ошибок и поведение retry/cooldown.
- **R7:** остановленный stream не выглядит работающим. Регрессии проверяются на переходах состояния, рендере и интерактивном выборе.

Новая схема хранения, миграция данных и расширение контракта причин между engines в этот объём не входят. Уже существующие сохранение skips, поля payload и короткие причины переиспользуются.

## 1. stage1-state

Файлы: [frontend/src/App.jsx](frontend/src/App.jsx), новый [frontend/src/stage1State.js](frontend/src/stage1State.js), [frontend/src/components/ChatInterface.jsx](frontend/src/components/ChatInterface.jsx).

Вынести чистые переходы Stage 1 в production-функцию, которую вызывает App. Проверку conversation id, React-обновления и `finishRun` оставить в App. Остальные stages не рефакторить.

Использовать уже существующий `stage1_skipped`. Не смешивать его со `stage1` или `stage1_failures`.

- Новый Stage 1 start/retry очищает skips предыдущей попытки и сохраняет текущую очистку и replay failures.
- `stage1_init`: `total = total_models`, `completed = existing_count || 0`, новый `progress.results`.
- Новый `model_complete`: добавить ответ, `completed + 1`.
- Новый `model_failed` без skipped: добавить failure, `completed + 1`.
- Новый `model_failed` со skipped: добавить skip-заметку, `total - 1` с нижней границей 0, `completed` не менять.
- Replay с `existing`: добавить возвращаемый ответ или failure для отображения, `completed` повторно не увеличивать.
- `stage1_complete` и `stage1_error`: принять финальные ответы и failures по текущему контракту. Проверить точное имя поля skips в реальном payload. Если финальный массив передан, заменить им накопленный UI-массив, включая явный `[]`. Если поле отсутствует, сохранить накопленные skips. Не конкатенировать финальный список с уже показанными событиями.
- Generic error: сохранить частичные ответы и заметки. Уже сброшенный loading останавливает streaming UI.

Считать samples, не уникальные model id. Два пропущенных sample уменьшают total на два.

Передать в Stage1 `skips` и `isRunning={Boolean(msg.loading?.stage1)}`. Отсутствие массива у старого сообщения — это `[]`. Показывать компонент и когда есть только skips. События чужой conversation по-прежнему игнорируются.

**Готово, когда** три новых слота success, failure, skip дают один ответ, `completed = 2` и `total = 2`. Replay не меняет уже учтённое completion. Зависимостей нет.

## 2. answer-tabs

Файлы: [frontend/src/components/Stage1.jsx](frontend/src/components/Stage1.jsx) и props из ChatInterface.

`answerTabs` строятся только из записей, где `response` — строка и `response.trim()` непустой. Trim только для проверки. Показывать и копировать исходный текст. Порядок и исходный индекс сохраняются. Не сортировать и не склеивать samples. Метки `#1`, `#2` считать среди видимых ответов одной модели.

Выбор:

- До клика показывать последний элемент `answerTabs`. Новый успешный ответ становится активным.
- После клика держать выбранный sample при append, failure, skip и переходе от `progress.results` к финальному `stage1`.
- На переход `isRunning` из false в true, до init, сбрасывать ручной выбор.
- Смена чата уже remount-ит ChatInterface через conversation key.
- Не использовать model id как ключ sample и не remount-ить Stage1 на каждом append или в конце stream.

В текущем engine финальный массив сохраняет порядок append. Индекса внутри одного запуска достаточно. Если рабочая копия начнёт менять этот порядок, идентификацию выбранного sample пересмотреть до реализации.

Streaming UI только при `isRunning && progress`. При `total > 0` подпись — `answerTabs.length/total responses`. Ширина полосы — `completed/total`, ограниченная 0–100%. При `total = 0` — `0 responses` и ширина 0%, без деления на ноль. Failure может заполнить полосу, не добавив вкладку.

После generic error скрыть spinner и progress, даже если объект progress остался. Ответы и заметки оставить. При нуле ответов, пока запуск активен, показать waiting. После остановки — `No successful responses`. Существующие retry-кнопки и stage-error остаются в ChatInterface.

**Готово, когда** поздний failure не выбран, ручной выбор переживает final, а whitespace legacy response не создаёт вкладку. Зависит от stage1-state.

## 3. diagnostic-notes

Файлы: [Stage1.jsx](frontend/src/components/Stage1.jsx), [Stage1.css](frontend/src/components/Stage1.css). [App.jsx](frontend/src/App.jsx) только чтобы убрать найденный debug fetch.

Под ответом plain-text список `Failed: модель — причина` и `Skipped: модель — причина`. При нуле ответов список стоит после waiting или empty, вне ветки active tab. Одна запись — одна короткая заметка. На узком экране текст переносится.

Formatter — локальная функция Stage1. Источник только `error.message`, и не любая строка:

- Оставить известные короткие сообщения, включая `Model not found (404)` и уже приходящие короткие skip-строки из `skipMessage`.
- Для `HTTP NNN: ...` показать безопасный HTTP-префикс, без provider body.
- Неизвестное или пустое failure message — `Request failed`.
- Skip без безопасной короткой строки — `Skipped`, без выдуманной harness или cooldown причины и без повторения этого слова в строке.

Обрезание длины не годится: JSON может стоять в начале. Не читать `detail` или `raw` и не класть исходную строку в tooltip или скрытую разметку.

Удалить `.tab-failed`, если после смены у него не останется потребителей. Удалить найденные `.tab-skipped` и debug fetch. Общие `.tab`, `.stage`, progress-стили и обычные `console.error` не трогать. Markdown и Copy для ответов сохранить.

**Готово, когда** notes видны и при смешанном результате, и без ответов, а sentinel provider payload не появляется в DOM ни из message, ни из detail. Зависит от stage1-state.

## 4. verify-stage1

Новые файлы: [frontend/src/stage1State.test.js](frontend/src/stage1State.test.js), [frontend/src/components/Stage1.test.jsx](frontend/src/components/Stage1.test.jsx).

Vitest в Node environment и установленный `react-dom/server`. Тестировать production helper, подключённый к App, а не копию переходов. Новые DOM-зависимости не добавлять.

- success, 404 failure, skip при `total = 3`: один ответ, `completed = 2`, `total = 2`, failure и skip разделены.
- init с `existing_count`, затем replay: completed не растёт повторно, записи по одному разу.
- Два samples одной модели: оба ответа и различимые вкладки. Два skip уменьшают total на два.
- complete и `stage1_error`: переданный финальный массив skips заменяет накопленный без дублей; явный `[]` очищает список; отсутствие поля сохраняет накопленные события. Failures принимаются по прежнему контракту.
- Загрузка сохранённого сообщения: существующие `stage1_skipped` отображаются после reload и повторного открытия чата. Старое сообщение без этого поля корректно использует `[]`.
- Новый start/retry: прежние skips очищены.
- All-failed и all-skipped: вкладок нет, notes видны, `total = 0` не даёт NaN или Infinity.
- Пустые, whitespace и нестроковые responses не создают вкладок. Годные ответы сохраняют порядок и текст.
- JSON в detail и отдельный fixture с JSON внутри message: sentinel отсутствует, безопасное summary есть.
- Все подтверждённые короткие строки `skipMessage` сохраняются в заметках. Неизвестная, пустая или структурированная строка заменяется безопасным fallback. Synthetic status 403 не используется для вывода причины.
- Без ручного выбора и с поздней ошибкой активен последний пригодный ответ.
- `isRunning = false` при непустом progress: ответы и notes видны, spinner и progress скрыты.
- В браузере: клик по раннему sample, затем новый ответ, failure и skip, затем final — выбранный sample и Copy остаются.
- В браузере: retry после ручного выбора и смена чата — новый запуск снова следует последнему ответу, выбор не переносится.
- В браузере: узкий экран, Markdown и Copy — заметки переносятся, ответы отображаются и копируются.

SSR не заменяет клики. Интерактивные строки — обязательный smoke с записанным результатом. Живые вызовы провайдера не нужны.

Из `frontend`:

```bash
npm test -- src/stage1State.test.js src/components/Stage1.test.jsx
npx eslint src/App.jsx src/components/ChatInterface.jsx src/components/Stage1.jsx src/stage1State.js src/stage1State.test.js src/components/Stage1.test.jsx
npm run build
```

Зафиксировать исходные lint-проблемы до правок. Критерий — нет новых ошибок в затронутых файлах. Посторонние замечания не исправлять в этой задаче.

**Готово, когда** автоматические проверки и интерактивные сценарии выполнены и их результаты записаны. Зависит от остальных трёх todo.

## Когда пересмотреть план

Если финальный массив или retry начнёт менять порядок Stage 1, сначала пересмотреть идентификацию выбранного sample. Если проверка рабочей копии не подтвердит описанные сохранение skips или поле финального payload, убрать соответствующее предположение и явно указать ограничение. Новое хранение в рамках этой UI-задачи не вводить. Новый общий контракт причин для обоих engines требует отдельной задачи.
