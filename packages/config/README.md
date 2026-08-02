# @aicl/config

Typed Windows operational configuration shared by Core and Connector.

The default file is `%LOCALAPPDATA%\AICL Mission Control\config.json`. It is
created atomically on first process start with schema version `1`; unknown
fields and unsupported versions fail startup closed. The schema contains only
loopback Core/Connector settings, exact browser origins, provider profile
references, canonical project paths, and operational filesystem paths. The
effective same-origin Core URL is derived after overrides so a port change
cannot strand the production UI. Provider credentials and process capabilities
are never valid config fields.

Development and tests may select another file with `AICL_CONFIG_PATH` and
override individual values with the documented `AICL_*` variables. Overrides
are validated but never written back to `config.json`.
