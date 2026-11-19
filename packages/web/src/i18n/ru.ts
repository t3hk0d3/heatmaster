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
  "group.frost_protection": "температура защиты от замерзания",
  "group.thermostat": "режим и целевая температура",

  "rooms.title": "Комнаты",
  "rooms.none": "Пока ни в одной зоне Home Assistant нет клапана, поэтому комнат нет.",
  "rooms.unknown": "Комнаты берутся из зон Home Assistant, поэтому без него они неизвестны.",
  "room.schedule": "Расписание: {name}",
  "room.no_schedule": "Расписания нет",
  "room.not_managed": "Не управляется",
  "room.not_managed_hint":
    "Heatmaster ничего не записывает в клапаны этой комнаты. Он начнёт, когда конфигурация будет сохранена, а связь с Home Assistant — настроена.",
  "room.not_managed_hint.unlinked":
    "Heatmaster ничего не записывает в клапаны этой комнаты. Он начнёт, когда будет настроена связь с Home Assistant (HA_URL и HA_TOKEN).",
  "room.not_managed_hint.no_config":
    "Heatmaster ничего не записывает в клапаны этой комнаты. Он начнёт, когда будет применена конфигурация.",
  "room.not_managed_hint.no_schedule":
    "Heatmaster ничего не записывает в клапаны этой комнаты. Он начнёт, когда в конфигурации появится расписание.",
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
  "valve.stranded":
    "Этого клапана больше нет ни в Home Assistant, ни в Zigbee2MQTT. Если его убрали, забудьте его.",

  "others.title": "Другие клапаны",
  "others.none": "Нет клапанов вне комнат.",
  "others.hint":
    "Эти клапаны не входят ни в одну комнату. Чтобы клапан получил комнату, отнесите его устройство к зоне в Home Assistant.",
  "others.hint_without_ha": "Эти клапаны не входят ни в одну комнату.",
  "others.not_reported": "Клапан ещё ничего не сообщил.",
  "others.reported": "Сообщённые значения",

  "house.frozen.not_loaded":
    "Состав комнат зафиксирован по последним сохранённым данным Home Assistant: Home Assistant ещё не загружен. Клапаны продолжают работать по расписаниям, но ни один клапан не добавляется в комнату и не убирается из неё.",
  "house.frozen.link_down":
    "Состав комнат зафиксирован по последним сохранённым данным Home Assistant: нет связи с Home Assistant. Клапаны продолжают работать по расписаниям, но ни один клапан не добавляется в комнату и не убирается из неё.",
  "house.unlinked":
    "Связь с Home Assistant не настроена (HA_URL и HA_TOKEN), поэтому Heatmaster не управляет ни одной комнатой.",
  "frozen_reason.not_loaded": "Home Assistant ещё не загружен",
  "frozen_reason.link_down": "нет связи с Home Assistant",

  "config_unreadable.title": "Сохранённую конфигурацию не удаётся прочитать",
  "config_unreadable.why":
    "Heatmaster не управляет комнатами и оставляет все клапаны как есть. После преобразования из старой версии так бывает, если конфигурация нарушает правило нового формата: например, два идентификатора расписаний дают одну и ту же метку Home Assistant (label_id_duplicate) или идентификатор расписания заканчивается дефисом или подчёркиванием с цифрами (schedule_id_reserved). Файл config.json в каталоге данных Heatmaster не изменён.",
  "config_unreadable.recover":
    "Чтобы всё исправить, напишите верную конфигурацию в редакторе ниже, отметьте «Перезаписать нечитаемую конфигурацию» и нажмите «Применить». Старый файл останется рядом под именем config.unreadable.<время>.json. Можно и поправить config.json вручную, а затем перезапустить Heatmaster.",

  "pending.title": "Клапаны, ожидающие подключения к комнате",
  "pending.hint":
    "Каждый из этих клапанов относится к комнате, но Heatmaster пока не взял его под управление. Heatmaster повторяет попытку не реже раза в 30 секунд и сразу, как только клапан что-то сообщит. Клапан с нечитаемыми исходными настройками ждёт, пока вы их не примете.",
  "pending.item": "{name} → комната «{room}»",
  "pending.unreadable": "Настройки, которые не удалось прочитать: {settings}",
  "pending.reason.house_frozen": "состав комнат зафиксирован, пока Home Assistant не вернётся",
  "pending.reason.ledger_unreadable":
    "не удаётся прочитать сохранённые исходные настройки клапанов",
  "pending.reason.transport_unusable": "клапан сейчас недоступен",
  "pending.reason.valve_not_observed": "клапан ещё не сообщил свои настройки",
  "pending.reason.originals_unreadable":
    "часть текущих настроек клапана не удаётся прочитать, поэтому их нельзя сохранить как исходные",
  "pending.accept": "Принять неизвестные исходные настройки",
  "pending.accept_question":
    "Принять неизвестные исходные настройки клапана {name}? Heatmaster возьмёт его под управление, не зная часть его исходных настроек, и не сможет вернуть их, когда клапан выйдет из комнаты.",

  "unused.title": "Неиспользуемые записи конфигурации",
  "unused.hint": "Сохранены на случай, если в зоне появится клапан.",

  "ha_changes.title": "Изменено в Home Assistant",
  "ha_changes.hint":
    "Эти версии конфигурации пришли из Home Assistant: изменения меток и импорт датчиков по метке room_temperature_sensor. Сначала самые новые.",
  "ha_changes.revision": "Версия {revision}, {time}",
  "ha_changes.item.schedule": "Расписание зоны «{area}»: {schedule}",
  "ha_changes.item.sensor_added": "Датчик {entity} добавлен в зону «{area}»",
  "ha_changes.item.sensor_removed": "Датчик {entity} убран из зоны «{area}»",
  "ha_changes.item.sensors_imported":
    "Датчики зоны «{area}» импортированы по метке room_temperature_sensor",
  "ha_changes.item.override_end": "Конец ручной настройки в {area}",

  "upgrade.title": "Конфигурация преобразована",
  "upgrade.intro":
    "Конфигурация переведена в новый формат. Теперь комнаты берутся из зон Home Assistant.",
  "upgrade.dropped_intro": "Эти старые комнаты сохранить не удалось:",
  "upgrade.none_dropped": "Все прежние комнаты сохранены.",
  "upgrade.room": "{name} ({roomId}), клапаны: {valves}. Причина: {reason}",
  "upgrade.no_valves": "нет",
  "upgrade.dropped.no_area": "в ней не указана зона Home Assistant",
  "upgrade.dropped.area_duplicate": "её зону уже занимает другая комната",
  "upgrade.dropped.area_id_invalid": "идентификатор зоны недопустим для Home Assistant",
  "upgrade.dismiss": "Скрыть",

  "unassigned.reason.no_area": "у его устройства нет зоны в Home Assistant",
  "unassigned.reason.ignored_area": "у его зоны есть метка heatmaster_ignore",
  "unassigned.reason.not_in_ha": "в Home Assistant для него нет устройства",

  "plan.pending": "Клапаны, которые продолжают ждать",

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
  "editor.overwrite": "Перезаписать нечитаемую конфигурацию",
  "editor.dirty": "Есть изменения, которые не применены.",
  "editor.server_changed":
    "Конфигурация на сервере изменилась. Ваш текст сохранён; нажмите «Загрузить заново», чтобы заменить его.",
  "editor.applied": "Применено как версия {revision}.",

  "plan.title": "Планируемое изменение",
  "plan.revision": "Конфигурация станет версией {revision}.",
  "plan.joining": "Клапаны, которые будут подключены к комнате",
  "plan.original": "{setting}: {value} ({evidence})",
  "plan.unreadable": "{setting}: прочитать не удалось",
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
  "membership.pending": "ожидает подключения к комнате",
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
  "setting.frost_protection": "Температура защиты от замерзания",
  "setting.system_mode": "Режим",
  "setting.setpoint": "Целевая температура",

  "evidence.acked": "подтверждено клапаном",
  "evidence.echoed": "как сообщил Zigbee2MQTT",
  "evidence.none": "проверить нельзя",

  "problem.config_unreadable":
    "Не удаётся прочитать конфигурацию Heatmaster. Клапаны оставлены как есть. Как всё исправить, написано в сообщении вверху страницы",
  "problem.ledger_unreadable":
    "Не удаётся прочитать сохранённые исходные настройки клапанов. Клапаны оставлены как есть",
  "problem.pacing_unreadable":
    "Не удаётся прочитать сохранённый учёт разрешённых записей в клапаны. Heatmaster начинает с пустым запасом у каждого клапана и пишет по мере его восстановления: одна запись в 30 минут на клапан",
  "problem.transport_unusable": "Heatmaster не может использовать {transport}: {reason}",
  "problem.link_down": "Нет связи с {name}",
  "problem.valve_pending": "Клапан {name} пока не удаётся подключить к комнате «{room}»: {reason}",
  "problem.ha_link_required":
    "Связь с Home Assistant не настроена (HA_URL и HA_TOKEN), поэтому комнаты не управляются",
  "problem.rooms_frozen":
    "Состав комнат зафиксирован по последним сохранённым данным Home Assistant: {reason}",
  "problem.no_schedule":
    "В конфигурации нет расписания, поэтому комнаты не управляются. Добавьте расписание в конфигурацию",
  "problem.valve_not_in_ha":
    "В Home Assistant нет устройства клапана {name}; он остаётся в прежней комнате",
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
  "problem.sensor_label_unused":
    "У датчика {name} есть метка heatmaster_temp_sensor, но ни одна комната его не использует: {reason}",
  "problem.sensor_label_unused.no_area": "датчик не отнесён ни к одной зоне",
  "problem.sensor_label_unused.area_not_room": "в его зоне нет клапана, поэтому это не комната",
  "problem.sensor_label_unused.entry_unavailable":
    "для его комнаты нельзя завести запись в конфигурации (записей уже 64 или идентификатор зоны не подходит Heatmaster)",
  "problem.sensor_label_unused.sensor_unknown": "Home Assistant не знает такого датчика",
  "problem.sensor_label_unused.sensor_not_temperature": "это не датчик температуры",
  "problem.sensor_label_unused.sensor_on_valve": "он принадлежит клапану",
  "problem.sensor_label_unused.sensor_limit": "в комнате уже максимальное число датчиков",
  "problem.legacy_label_present":
    "У комнаты «{name}» есть датчики Heatmaster, но у {entities} всё ещё стоит метка room_temperature_sensor. Ваша автоматизация продолжает передавать температуру в комнату, пока вы не снимете метку room_temperature_sensor с датчиков комнаты",
  "problem.entry_unavailable":
    "Для зоны {name} нельзя завести запись в конфигурации (записей уже 64 или идентификатор зоны не подходит Heatmaster), поэтому её метки {labels} не учитываются",
  "problem.label_foreign":
    "Метка Home Assistant {name} похожа на метку расписания Heatmaster, но ею не является, поэтому Heatmaster её не трогает",
  "problem.ha_label_failed":
    "Heatmaster не смог изменить метки в Home Assistant ({op}, {name}): {error}",
  "label_error.unauthorized":
    "пользователь токена не администратор Home Assistant, а менять метки может только администратор",
  "label_error.timeout": "Home Assistant не ответил вовремя",
  "label_error.link_down": "связь с Home Assistant прервалась",
  "label_op.createLabel": "создание метки",
  "label_op.renameLabel": "переименование метки",
  "label_op.deleteLabel": "удаление метки",
  "label_op.labelArea": "назначение метки зоне",
  "label_op.labelEntity": "назначение метки датчику",
  "problem.sensor_unlabellable":
    "Датчик {name} есть в конфигурации, но в реестре Home Assistant его нет, поэтому Heatmaster не может его пометить",

  "error.config_unreadable":
    "Конфигурацию не удаётся прочитать, поэтому её нельзя изменить. Смотрите сообщение вверху страницы.",
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
  "error.transport_unusable": "Клапан {valveId} сейчас недоступен.",
  "error.valve_not_orphan": "Клапан {valveId} не лишён комнаты.",
  "error.valve_managed":
    "Клапан {valveId} находится в комнате. Сначала уберите его из конфигурации.",
  "error.valve_not_pending":
    "Клапан {valveId} не ожидает принятия неизвестных исходных настроек. Возможно, он уже подключён к своей комнате.",
  "error.schedule_in_use":
    "Пока есть комнаты, в конфигурации нужно хотя бы одно расписание: например, оно нужно комнате {roomId}.",
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
  "error.state_unreadable":
    "Сохранённые состояния комнат не удаётся прочитать, поэтому комнаты нельзя изменить. Начните заново, чтобы вернуть все комнаты к их расписаниям.",
  "error.schedule_unknown": "Расписания {scheduleId} нет.",
  "error.config_missing": "Конфигурации ещё нет.",
  "error.ask_limited": "Клапан {valveId} только что получил запрос. Повторите через минуту.",
  "error.not_started": "Heatmaster ещё не закончил запуск.",
  "error.store_locked":
    "Файл Heatmaster не удалось прочитать при загрузке, поэтому Heatmaster не будет его перезаписывать. Для исходных настроек клапанов нажмите «Импортировать сохранённые исходные настройки». Для конфигурации напишите верную в редакторе, отметьте «Перезаписать нечитаемую конфигурацию» и примените её; старый файл останется рядом.",
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
