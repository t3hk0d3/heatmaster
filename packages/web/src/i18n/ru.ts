import type { Dictionary } from "../i18n.ts";

export const ru: Dictionary = {
  "app.title": "Heatmaster",
  "app.loading": "Ожидание первого состояния от Heatmaster…",
  unknown: "—",

  "header.links": "Связи",
  "header.up": "есть",
  "header.down": "нет",
  "header.status.connecting": "Подключение к Heatmaster…",
  "header.status.live": "Связь с Heatmaster есть",
  "header.status.lost": "Связь с Heatmaster потеряна. Пробуем снова…",
  "header.held": "Запись в клапаны остановлена",
  "header.not_held": "Heatmaster записывает настройки в клапаны",
  "header.stop": "Остановить запись",
  "header.release": "Разрешить запись",
  "header.release_question":
    "Разрешить запись? Heatmaster снова начнёт писать в клапаны и сможет менять их настройки.",
  "header.revision": "Версия конфигурации {revision}",
  "header.diagnostics": "Диагностика",
  "header.language": "Язык",
  "header.language_en": "English",
  "header.language_ru": "Русский",

  "link.z2m": "Zigbee2MQTT",
  "link.ha": "Home Assistant",

  "reason.mqtt_unavailable": "брокер MQTT недоступен",
  "reason.mqtt_auth_failed": "брокер MQTT отклонил вход",
  "reason.bridge_unknown": "Zigbee2MQTT не сообщил о себе",
  "reason.version_unsupported": "эта версия Zigbee2MQTT не поддерживается",
  "reason.last_seen_disabled": "в Zigbee2MQTT выключена настройка last_seen",
  "reason.another_instance": "запущен другой Heatmaster",

  "store.config": "конфигурацию",
  "store.ledger": "сохранённые исходные настройки клапанов",
  "store.copy": "читаемую копию сохранённых исходных настроек",

  "group.schedule": "расписание",
  "group.active_group": "активная группа расписания",
  "group.sensor_source": "источник температуры",

  "rooms.title": "Комнаты",
  "rooms.none": "Комнаты ещё не настроены.",
  "rooms.temperature": "Температура",
  "rooms.target": "Цель",
  "rooms.sync": "Синхронизация",
  "rooms.degraded": "Ограничено: в комнате нет работающего датчика температуры",
  "rooms.diverged": "Расхождение: клапаны не согласованы",
  "rooms.valves": "Клапаны",
  "rooms.no_valves": "В комнате нет клапанов.",

  "valve.id": "Идентификатор",
  "valve.membership": "Статус",
  "valve.liveness": "Отклик",
  "valve.sync": "Синхронизация",
  "valve.battery": "Батарея {percent} %",
  "valve.refresh": "Запросить данные",
  "valve.restore": "Вернуть исходные настройки",
  "valve.forget": "Забыть",
  "valve.forget_question":
    "Забыть клапан {name}? Его сохранённые исходные настройки будут удалены без возможности восстановления.",
  "valve.not_supported": "Не поддерживается",

  "others.title": "Другие клапаны",
  "others.none": "Нет клапанов вне комнат.",
  "others.hint": "Скопируйте идентификатор клапана в комнату в конфигурации, чтобы добавить его.",
  "others.not_reported": "Клапан ещё ничего не сообщил.",
  "others.reported": "Сообщённые значения",

  "problems.title": "Проблемы",
  "problems.none": "Проблем нет.",

  "originals.found":
    "Найдены сохранённые исходные настройки {count} клапанов от прежней установки. Импортируйте их, прежде чем добавлять клапаны; ненужные можно потом забыть",
  "originals.import": "Импортировать сохранённые исходные настройки",
  "originals.import_empty": "Начать с пустой записи",
  "originals.import_empty_question":
    "Начать с пустой записи исходных настроек? У клапанов, которыми Heatmaster занимался раньше, исходных настроек не будет.",
  "originals.copy_records": "В сохранённой копии записей: {count}.",
  "originals.no_copy": "Нет сохранённой копии для импорта.",

  "editor.title": "Конфигурация (YAML)",
  "editor.preview": "Предпросмотр",
  "editor.apply": "Применить",
  "editor.reload": "Загрузить заново",
  "editor.accept": "Принять нечитаемые исходные настройки клапана {name}",
  "editor.overwrite": "Перезаписать нечитаемую конфигурацию",
  "editor.dirty": "Есть изменения, которые не применены.",
  "editor.server_changed":
    "Конфигурация на сервере изменилась. Ваш текст сохранён; нажмите «Загрузить заново», чтобы заменить его.",
  "editor.applied": "Применено как версия {revision}.",

  "plan.title": "Планируемое изменение",
  "plan.revision": "Конфигурация станет версией {revision}.",
  "plan.joining": "Клапаны, которые войдут в комнату",
  "plan.original": "{setting}: {value} ({evidence})",
  "plan.unreadable": "{setting}: прочитать не удалось",
  "plan.rejoining": "Клапаны, которые вернутся в комнату",
  "plan.leaving": "Клапаны, которые выйдут из комнаты",
  "plan.writes": "Запись в клапаны",
  "plan.nothing": "Ничего записано не будет.",
  "plan.held": "После этого изменения запись остаётся остановленной.",
  "plan.not_held": "После этого изменения Heatmaster будет записывать настройки в клапаны.",

  "sync.in_sync": "согласовано",
  "sync.pending": "ждём клапан",
  "sync.not_holding": "клапан не сохраняет настройку",
  "sync.unverified": "ещё не проверено",
  "sync.held": "запись остановлена",
  "sync.frozen": "заморожено",

  "membership.managed": "управляется",
  "membership.not_adopted": "не принят",
  "membership.releasing": "возвращается",
  "membership.stray": "посторонний",
  "membership.orphan": "без комнаты",
  "membership.frozen": "заморожен",

  "liveness.unknown": "неизвестно",
  "liveness.live": "отвечает",
  "liveness.silent": "молчит",

  "mode.off": "выключен",
  "mode.auto": "авто",
  "mode.heat": "нагрев",

  "severity.warning": "Предупреждение",
  "severity.error": "Ошибка",
  "severity.critical": "Критично",

  "setting.day_mon": "Расписание на понедельник",
  "setting.day_tue": "Расписание на вторник",
  "setting.day_wed": "Расписание на среду",
  "setting.day_thu": "Расписание на четверг",
  "setting.day_fri": "Расписание на пятницу",
  "setting.day_sat": "Расписание на субботу",
  "setting.day_sun": "Расписание на воскресенье",
  "setting.active_group": "Активная группа расписания",
  "setting.sensor_source": "Источник температуры",

  "evidence.acked": "подтверждено клапаном",
  "evidence.echoed": "как сообщил Zigbee2MQTT",
  "evidence.none": "проверить нельзя",

  "problem.config_unreadable":
    "Не удаётся прочитать конфигурацию Heatmaster. Клапаны оставлены как есть",
  "problem.ledger_unreadable":
    "Не удаётся прочитать сохранённые исходные настройки клапанов. Клапаны оставлены как есть",
  "problem.transport_unusable": "Heatmaster не может использовать {transport}: {reason}",
  "problem.link_down": "Нет связи с {name}",
  "problem.valve_not_adopted":
    "Клапан {name} находится в комнате, но его исходные настройки не были сохранены",
  "problem.valve_orphan": "Клапан {name} больше не входит ни в одну комнату и не был возвращён",
  "problem.valve_unsupported": "Модель клапана {name} не поддерживается",
  "problem.valve_silent": "Клапан {name} не отвечает",
  "problem.setting_not_holding": "Клапан {name} не сохраняет настройку «{setting}»",
  "problem.release_stalled": "Клапан {name} пока не удалось вернуть к исходным настройкам",
  "problem.schedule_clamped": "Клапан {name} допускает только {min}–{max} °C",
  "problem.room_no_temperature": "В комнате «{name}» нет работающего датчика температуры",
  "problem.sensor_stale": "Датчик {name} перестал присылать данные",
  "problem.sensor_out_of_range": "Датчик {name} показывает неправдоподобную температуру",
  "problem.sensor_liveness_unobservable":
    "Heatmaster не может определить, работает ли датчик {name}",
  "problem.feed_lost": "Клапан {name} не получает температуру комнаты",
  "problem.valve_not_auto":
    "Клапан {name} в режиме «{mode}» и не следует расписанию. Heatmaster не меняет режим клапана",
  "problem.store_write_failed":
    "Heatmaster не смог сохранить {store}. Проверьте диск: запись в клапаны может быть остановлена, пока сохранение не удастся",
  "problem.tick_failed":
    "Внутренний сбой Heatmaster при выборе того, что отправить: клапаны не получают ни записей, ни температуры комнаты. Смотрите его журнал",

  "error.config_unreadable": "Конфигурацию не удаётся прочитать, поэтому её нельзя изменить.",
  "error.revision_conflict":
    "Конфигурацию изменил кто-то другой: вы правили версию {expected}, на сервере версия {current}. Загрузите её заново и внесите правки ещё раз.",
  "error.timezone_missing":
    "Часовой пояс неизвестен. Укажите timezone в настройках конфигурации: связи с Home Assistant нет, и он не сообщит часовой пояс дома.",
  "error.ha_link_missing": "Для датчика {sensor} нужна связь с Home Assistant, а она не настроена.",
  "error.sensor_unknown": "Датчика {sensor} нет в Home Assistant.",
  "error.sensor_not_temperature": "{sensor} не является датчиком температуры.",
  "error.sensor_on_valve": "{sensor} принадлежит клапану и не может быть датчиком комнаты.",
  "error.valve_unknown": "Клапан {valveId} неизвестен Heatmaster.",
  "error.valve_unsupported": "Модель клапана {valveId} не поддерживается.",
  "error.ledger_unreadable":
    "Не удаётся прочитать сохранённые исходные настройки клапанов, поэтому добавлять клапаны нельзя.",
  "error.transport_unusable": "Клапан {valveId} сейчас недоступен через {transport}.",
  "error.valve_not_observed":
    "Клапаны {valveIds} ещё ничего не сообщили. Им отправлен запрос; повторите попытку чуть позже.",
  "error.originals_unreadable":
    "Не удалось прочитать исходные настройки клапана {valveId} ({settings}). Чтобы всё же добавить клапан, примите это ниже и повторите предпросмотр.",
  "error.valve_not_orphan": "Клапан {valveId} не лишён комнаты.",
  "error.valve_managed":
    "Клапан {valveId} находится в комнате. Сначала уберите его из конфигурации.",
  "error.not_ready": "Heatmaster ещё запускается. Повторите чуть позже.",
  "error.mqtt_fault": "Проблема с подключением к MQTT: {reason}.",
  "error.body_invalid": "Запрос некорректен.",
  "error.config_or_yaml": "В запросе должен быть либо config, либо yaml: не оба и не ни одного.",
  "error.yaml_invalid": "YAML не удаётся прочитать.",
  "error.config_invalid": "В конфигурации есть ошибки:",
  "error.body_too_large": "Запрос слишком большой.",
  "error.not_found": "По этому адресу ничего нет.",
  "error.internal": "Внутренний сбой Heatmaster. Смотрите его журнал.",
  "error.room_unknown": "Комнаты {roomId} нет.",
  "error.config_missing": "Конфигурации ещё нет.",
  "error.ask_limited": "Клапан {valveId} только что получил запрос. Повторите через минуту.",
  "error.not_started": "Heatmaster ещё не закончил запуск.",
  "error.store_locked":
    "Файл Heatmaster не удалось прочитать при загрузке, поэтому Heatmaster не будет его перезаписывать. Для исходных настроек клапанов нажмите «Импортировать сохранённые исходные настройки»; для конфигурации выберите «Перезаписать нечитаемую конфигурацию» и примените её снова.",
  "error.no_originals_copy": "Нет читаемой копии сохранённых исходных настроек.",
  "error.ledger_readable": "Сохранённые исходные настройки читаются, импортировать нечего.",
  "error.device_unknown": "Устройство {deviceId} неизвестно.",
  "error.mqtt_not_connected": "Heatmaster не подключён к брокеру MQTT.",
  "error.mqtt_timeout": "Брокер MQTT не ответил вовремя.",
  "error.mqtt_refused": "Брокер MQTT отклонил запрос (код причины {reasonCode}).",
  "error.topic_invalid": "Тема MQTT {topic} недопустима.",
  "error.io_failed": "Heatmaster не смог прочитать или записать свои файлы. Проверьте диск.",
  "error.network": "Не удаётся связаться с Heatmaster.",
  "error.http": "Сервер ответил со статусом {status}, а не ответом Heatmaster.",
};
