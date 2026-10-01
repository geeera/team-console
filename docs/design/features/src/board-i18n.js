/* Strings of the #134 page. The board's own strings are the app's `board.*` keys from #18, unchanged: the lane
   switcher needs no new copy (its name is `board.lanes`, each tab is the lane name and its count). Only the page
   chrome, the demo bar and the #108 preview headings are new here. */
const I18N = {
  en: {
    'page.kicker': 'Team Console · #134 · design for approval',
    'page.title': 'Board on the phone: lane switcher',
    'page.layout': 'Layout', 'page.both': 'Both',
    'page.theme': 'Theme', 'page.auto': 'Auto', 'page.light': 'Light', 'page.dark': 'Dark',
    'page.motion': 'Motion', 'page.motionSystem': 'Motion: system', 'page.motionReduce': 'Reduced',
    'page.lang': 'Language', 'page.reset': 'Reset demo',
    'page.summary': 'What you are approving, and the tokens it uses',
    'page.phoneAria': 'iPhone layout', 'page.macAria': 'Mac layout', 'page.macLabel': 'Mac · window (unchanged)',

    'demo.aria': 'Demo states',
    'demo.version': 'Version', 'demo.v.new': 'New: lane switcher', 'demo.v.old': 'Now: swipe row (#134)',
    'demo.data': 'Data',
    'demo.d.sprint': 'Sprint 01 (QA’s data from #129)', 'demo.d.early': 'Early sprint: Done is empty',
    'demo.d.unknown': 'An unknown status label from GitHub', 'demo.d.s108': '#108 preview: current, next, backlog',
    'demo.help': 'On iPhone, tap a lane in the switcher: only that lane shows, and “Open pull requests” follows it. “Now: swipe row” is today’s board with the gap from #134. The Mac window is the same in both versions.',

    'nav.questions': 'Questions', 'nav.chat': 'Chat', 'nav.board': 'Board', 'nav.artifacts': 'Artifacts', 'nav.demo': 'Demo',
    'nav.sections': 'Project sections', 'nav.switch': 'Project {name}, switch project', 'nav.settings': 'Settings',
    'nav.app': 'Team console', 'nav.waiting': 'Waiting for you', 'nav.all': 'All projects', 'nav.projects': 'Projects',

    'board.demoIn': 'Demo 16 October · in 15 days',
    'board.stat.done': 'Done', 'board.stat.doneValue': '{shipped} of {planned}', 'board.stat.stillOpen': 'Still open', 'board.stat.openPrs': 'Open PRs',
    'board.lanes': 'Sprint issues by status',
    'board.status.proposed': 'Proposed', 'board.status.approved': 'Approved', 'board.status.in-progress': 'In progress',
    'board.status.qa': 'QA', 'board.status.blocked': 'Blocked', 'board.status.done': 'Done', 'board.status.none': 'No status',
    'board.laneEmpty': 'Nothing here', 'board.tierLabel': 'Tier:',
    'board.tier.light': 'light', 'board.tier.standard': 'standard', 'board.tier.heavy': 'heavy',
    'board.opensGitHub': '(opens on GitHub)',
    'board.pulls': 'Open pull requests',

    'p108.current': 'Current sprint', 'p108.next': 'Next sprint', 'p108.backlog': 'Backlog',
    'p108.note': 'Preview of #108 for layout only: its sections, copy and loading are designed in #108.',
  },
  ru: {
    'page.kicker': 'Team Console · #134 · дизайн на согласование',
    'page.title': 'Доска на телефоне: переключатель дорожек',
    'page.layout': 'Вид', 'page.both': 'Оба',
    'page.theme': 'Тема', 'page.auto': 'Авто', 'page.light': 'Светлая', 'page.dark': 'Тёмная',
    'page.motion': 'Анимация', 'page.motionSystem': 'Анимация: как в системе', 'page.motionReduce': 'Меньше движения',
    'page.lang': 'Язык', 'page.reset': 'Сбросить демо',
    'page.summary': 'Что утверждаешь и какие токены использует дизайн',
    'page.phoneAria': 'Вид на iPhone', 'page.macAria': 'Вид на Mac', 'page.macLabel': 'Mac · окно (без изменений)',

    'demo.aria': 'Состояния для демо',
    'demo.version': 'Версия', 'demo.v.new': 'Новое: переключатель дорожек', 'demo.v.old': 'Сейчас: ряд со свайпом (#134)',
    'demo.data': 'Данные',
    'demo.d.sprint': 'Sprint 01 (данные QA из #129)', 'demo.d.early': 'Начало спринта: «Готово» пусто',
    'demo.d.unknown': 'Незнакомый статус из GitHub', 'demo.d.s108': 'Превью #108: текущий, следующий, бэклог',
    'demo.help': 'На iPhone нажми дорожку в переключателе: видна только она, и «Открытые пул-реквесты» идут сразу за ней. «Сейчас: ряд со свайпом» — сегодняшняя доска с пустотой из #134. Окно Mac одинаковое в обеих версиях.',

    'nav.questions': 'Вопросы', 'nav.chat': 'Чат', 'nav.board': 'Доска', 'nav.artifacts': 'Артефакты', 'nav.demo': 'Демо',
    'nav.sections': 'Разделы проекта', 'nav.switch': 'Проект {name}, сменить проект', 'nav.settings': 'Настройки',
    'nav.app': 'Консоль команды', 'nav.waiting': 'Ждут тебя', 'nav.all': 'Все проекты', 'nav.projects': 'Проекты',

    'board.demoIn': 'Демо 16 октября · через 15 дней',
    'board.stat.done': 'Готово', 'board.stat.doneValue': '{shipped} из {planned}', 'board.stat.stillOpen': 'Ещё открыто', 'board.stat.openPrs': 'Открытые PR',
    'board.lanes': 'Задачи спринта по статусам',
    'board.status.proposed': 'Предложено', 'board.status.approved': 'Одобрено', 'board.status.in-progress': 'В работе',
    'board.status.qa': 'На проверке', 'board.status.blocked': 'Заблокировано', 'board.status.done': 'Готово', 'board.status.none': 'Без статуса',
    'board.laneEmpty': 'Пусто', 'board.tierLabel': 'Сложность:',
    'board.tier.light': 'лёгкая', 'board.tier.standard': 'средняя', 'board.tier.heavy': 'тяжёлая',
    'board.opensGitHub': '(откроется на GitHub)',
    'board.pulls': 'Открытые пул-реквесты',

    'p108.current': 'Текущий спринт', 'p108.next': 'Следующий спринт', 'p108.backlog': 'Бэклог',
    'p108.note': 'Превью #108 только для раскладки: секции, тексты и загрузка проектируются в #108.',
  },
};
