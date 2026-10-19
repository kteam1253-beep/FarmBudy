rcDebug("RuntimeStats Class")

-- RuntimeStats
--
-- Svrha:
--   - Akumulira player hours (online / AFK) i "last online".
--   - Akumulira usage po vozilu i po igracu u vozilu (total / moving / idle).
--
-- Napomena:
--   FSG_Companion trenutno vec izvozi vehicleStats.xml (ukljucuje operatingTime/hours),
--   ali to je "engine hours" po vozilu. Ovdje dodajemo "user usage" (tko je vozio i koliko).

RuntimeStats = {}
local RuntimeStats_mt = Class(RuntimeStats)

-- Pragovi i tunables (ms / m)
RuntimeStats.UPDATE_INTERVAL_MS = 1000              -- koliko cesto racunamo (1s)
RuntimeStats.AFK_TIMEOUT_MS     = 6 * 60 * 1000     -- AFK ako nema aktivnosti 6 min
RuntimeStats.MOVE_DIST_M        = 0.75              -- aktivnost pješke ako se pomaknuo vise od 0.75m u intervalu
RuntimeStats.VEH_MOVING_MS      = 0.8               -- moving threshold (m/s) ako imamo speed
RuntimeStats.TRACK_EXPORT_INTERVAL_MS = 60 * 1000   -- export tracking XML to outbox every 60s (if enabled)               -- moving threshold (m/s) ako imamo speed

function RuntimeStats.new(mission, i18n, modDirectory, modName)
  local self = setmetatable({}, RuntimeStats_mt)
  self.mission      = mission
  self.i18n         = i18n
  self.modDirectory = modDirectory
  self.modName      = modName

  self._accMs = 0

  -- player state: [uniqueUserId] => {...}
  self.players = {}

  -- vehicle usage state: [vehUniqueId] => {name,farmId,totalMs,movingMs,idleMs, byPlayer={}}
  self.vehicles = {}

  -- za detekciju disconnecta
  self._lastConnected = {}

  -- tracking/session history (for Discord map + analytics)
  self._trackExportAccMs = 0
  self.sessionHistory = {}

  -- cache pozicija vozila ako nemamo speed API
  self._vehPos = {}

  -- ucitaj prethodne vrijednosti iz savegame (ako postoje)
  self:loadFromSavegame()

  return self
end

function RuntimeStats:delete()
  -- nista
end

-- Pomocna: safe broj
local function toNumber(v, fallback)
  local n = tonumber(v)
  if n == nil then return fallback end
  return n
end

-- Pomocna: get savegame folder
function RuntimeStats:getSavegameFolder()
  if g_currentMission == nil or g_currentMission.missionInfo == nil then
    return nil
  end
  return getUserProfileAppPath() .. "savegame" .. g_currentMission.missionInfo.savegameIndex
end

-- Ucitaj prethodne stats (ako postoji)
function RuntimeStats:loadFromSavegame()
  local folder = self:getSavegameFolder()
  if folder == nil then return end

  local playerFile = folder .. "/playerTimeStats.xml"
  if fileExists(playerFile) then
    local xml = XMLFile.load("playerTimeStats", playerFile)
    if xml ~= nil then
      -- v2 uses uniqueUserId as key; old data keyed by server userId is unreliable
      local version = xml:getInt("playerTimeStats#version", 0)
      if version < 2 then
        rcDebug("RuntimeStats: Old playerTimeStats.xml (version " .. tostring(version) .. ") — discarding stale data keyed by server slot")
        xml:delete()
        -- delete the old file so it doesn't keep being loaded
        deleteFile(playerFile)
      else
        local i = 0
        while true do
          local key = string.format("playerTimeStats.player(%d)", i)
          if not xml:hasProperty(key) then break end
          local uniqueUserId = xml:getString(key .. "#uniqueUserId")
          if uniqueUserId ~= nil and uniqueUserId ~= "" then
            self.players[uniqueUserId] = self.players[uniqueUserId] or {}
            local p = self.players[uniqueUserId]
            p.id = xml:getString(key .. "#id") or p.id
            p.nickname = xml:getString(key .. "#nickname") or p.nickname
            p.uniqueUserId = uniqueUserId
            p.farmId = xml:getString(key .. "#farmId") or p.farmId
            p.totalOnlineMs = toNumber(xml:getString(key .. "#totalOnlineMs"), 0)
            p.totalAfkMs    = toNumber(xml:getString(key .. "#totalAfkMs"), 0)
            p.lastOnlineAt  = xml:getString(key .. "#lastOnlineAt") or p.lastOnlineAt
          end
          i = i + 1
        end
        xml:delete()
      end
    end
  end

  local vehFile = folder .. "/vehicleUsageStats.xml"
  if fileExists(vehFile) then
    local xml = XMLFile.load("vehicleUsageStats", vehFile)
    if xml ~= nil then
      local i = 0
      while true do
        local vKey = string.format("vehicleUsageStats.vehicle(%d)", i)
        if not xml:hasProperty(vKey) then break end
        local uid = xml:getString(vKey .. "#uniqueId")
        if uid ~= nil then
          local v = self.vehicles[uid] or { byPlayer = {} }
          v.uniqueId = uid
          v.name     = xml:getString(vKey .. "#name") or v.name
          v.farmId   = xml:getString(vKey .. "#farmId") or v.farmId
          v.totalMs  = toNumber(xml:getString(vKey .. "#totalMs"), 0)
          v.movingMs = toNumber(xml:getString(vKey .. "#movingMs"), 0)
          v.idleMs   = toNumber(xml:getString(vKey .. "#idleMs"), 0)

          local j = 0
          while true do
            local pKey = string.format(vKey .. ".player(%d)", j)
            if not xml:hasProperty(pKey) then break end
            local pid = xml:getString(pKey .. "#id")
            if pid ~= nil then
              v.byPlayer[pid] = v.byPlayer[pid] or {}
              local vp = v.byPlayer[pid]
              vp.id = pid
              vp.nickname = xml:getString(pKey .. "#nickname") or vp.nickname
              vp.totalMs  = toNumber(xml:getString(pKey .. "#totalMs"), 0)
              vp.movingMs = toNumber(xml:getString(pKey .. "#movingMs"), 0)
              vp.idleMs   = toNumber(xml:getString(pKey .. "#idleMs"), 0)
              vp.lastUsedAt = xml:getString(pKey .. "#lastUsedAt") or vp.lastUsedAt
            end
            j = j + 1
          end
          self.vehicles[uid] = v
        end
        i = i + 1
      end
      xml:delete()
    end
  end
end

-- Safe dohvat player objekta iz user-a
function RuntimeStats:getPlayerObjectForUser(user)
  if user == nil or self.mission == nil then return nil end
  local connection = user:getConnection()
  if connection == nil then return nil end
  if self.mission.connectionsToPlayer == nil then return nil end
  return self.mission.connectionsToPlayer[connection]
end

-- Safe dohvat trenutnog vozila za player-a
function RuntimeStats:getCurrentVehicle(player)
  if player == nil then return nil end
  if player.getCurrentVehicle ~= nil then
    return player:getCurrentVehicle()
  end
  if player.getVehicle ~= nil then
    return player:getVehicle()
  end
  if player.vehicle ~= nil then
    return player.vehicle
  end
  return nil
end

-- Procijeni je li vozilo u pokretu
function RuntimeStats:isVehicleMoving(vehicle, dtSec)
  if vehicle == nil then return false end

  -- 1) Ako postoji brzina
  if vehicle.getLastSpeed ~= nil then
    local s = vehicle:getLastSpeed() -- u m/s
    if s ~= nil then
      return s >= RuntimeStats.VEH_MOVING_MS
    end
  end
  if vehicle.lastSpeedReal ~= nil then
    return vehicle.lastSpeedReal >= RuntimeStats.VEH_MOVING_MS
  end

  -- 2) Fallback: delta pozicije
  local uid = nil
  if vehicle.getUniqueId ~= nil then uid = vehicle:getUniqueId() end
  if uid == nil then return false end

  local x, y, z = getWorldTranslation(vehicle.rootNode)
  local prev = self._vehPos[uid]
  self._vehPos[uid] = { x = x, y = y, z = z }
  if prev == nil then return false end
  if dtSec <= 0 then return false end
  local dx = x - prev.x
  local dz = z - prev.z
  local dist = math.sqrt(dx*dx + dz*dz)
  local speed = dist / dtSec
  return speed >= RuntimeStats.VEH_MOVING_MS
end

-- Update loop (poziva se preko addModEventListener)
function RuntimeStats:update(dt)
  if g_server == nil or g_dedicatedServer == nil then
    return
  end
  if self.mission == nil or self.mission.userManager == nil then
    return
  end

  self._accMs = self._accMs + dt
  if self._accMs < RuntimeStats.UPDATE_INTERVAL_MS then
    return
  end
  local tickMs = self._accMs
  self._accMs = 0

  local nowMs = self.mission.time
  local dtSec = tickMs / 1000

  -- settings (tracking + AFK kick)
  local trackEnabled = (g_fsgSettings ~= nil and g_fsgSettings.settings ~= nil) and g_fsgSettings.settings:getValue("enablePlayerTracking")
  if trackEnabled == nil then trackEnabled = true end
  local trackIntervalSec = (g_fsgSettings ~= nil and g_fsgSettings.settings ~= nil) and g_fsgSettings.settings:getValue("trackingIntervalSec") or 10
  local trackMaxPoints = (g_fsgSettings ~= nil and g_fsgSettings.settings ~= nil) and g_fsgSettings.settings:getValue("trackingMaxPoints") or 600
  local idleKickEnabled = (g_fsgSettings ~= nil and g_fsgSettings.settings ~= nil) and g_fsgSettings.settings:getValue("trackingIdleKickEnabled") or false
  local idleKickMinutes = (g_fsgSettings ~= nil and g_fsgSettings.settings ~= nil) and g_fsgSettings.settings:getValue("trackingIdleKickMinutes") or 60
  local idleRadiusM = (g_fsgSettings ~= nil and g_fsgSettings.settings ~= nil) and g_fsgSettings.settings:getValue("trackingIdleRadiusM") or 5
  local warn1 = (g_fsgSettings ~= nil and g_fsgSettings.settings ~= nil) and g_fsgSettings.settings:getValue("trackingWarnMinutes1") or 45
  local warn2 = (g_fsgSettings ~= nil and g_fsgSettings.settings ~= nil) and g_fsgSettings.settings:getValue("trackingWarnMinutes2") or 55
  if trackIntervalSec == nil or trackIntervalSec < 1 then trackIntervalSec = 10 end
  if trackMaxPoints == nil or trackMaxPoints < 50 then trackMaxPoints = 50 end
  if idleKickMinutes == nil or idleKickMinutes < 1 then idleKickMinutes = 60 end
  if idleRadiusM == nil or idleRadiusM < 1 then idleRadiusM = 5 end

  local connectedNow = {}
  local users = self.mission.userManager:getUsers() or {}
  for _, user in ipairs(users) do
    if user ~= nil and user.nickname ~= "Server" then
      local uid = tostring(user.id)
      -- Key by uniqueUserId (platform ID) to avoid slot reuse contamination
      local puid = nil
      if user.getUniqueUserId ~= nil then
        puid = tostring(user:getUniqueUserId())
      end
      if puid == nil or puid == "" then puid = uid end -- fallback
      connectedNow[puid] = true

      local p = self.players[puid] or {}
      p.id = uid
      p.nickname = user.nickname
      p.uniqueUserId = puid
      -- Track player's farmId (for scoreboard farm assignment)
      local playerFarm = g_farmManager ~= nil and g_farmManager.getFarmByUserId ~= nil and g_farmManager:getFarmByUserId(user.id) or nil
      if playerFarm ~= nil and playerFarm.farmId ~= nil then
        p.farmId = tostring(playerFarm.farmId)
      end
      p.totalOnlineMs = (p.totalOnlineMs or 0) + tickMs

      -- Player object (za poziciju i vozilo)
      local playerObj = self:getPlayerObjectForUser(user)

      local isActive = false
      if playerObj ~= nil and playerObj.rootNode ~= nil and playerObj.rootNode ~= 0 then
        local x, y, z = getWorldTranslation(playerObj.rootNode)
        if p._lastPos ~= nil then
          local dx = x - p._lastPos.x
          local dz = z - p._lastPos.z
          local dist = math.sqrt(dx*dx + dz*dz)
          if dist >= RuntimeStats.MOVE_DIST_M then
            isActive = true
          end
        end
        p._lastPos = { x = x, y = y, z = z }

        -- session init (on first sight / join)
        p._sessionStartMs = p._sessionStartMs or nowMs
        p._lastMoveMs = p._lastMoveMs or nowMs
        p._trackPoints = p._trackPoints or {}
        p._trackAccMs = (p._trackAccMs or 0) + tickMs
        p._sessionDistanceM = p._sessionDistanceM or 0
        p._sessionActiveMs = p._sessionActiveMs or 0
        p._sessionIdleMs = p._sessionIdleMs or 0

        -- Movement distance for session analytics
        if p._lastPosPrev ~= nil then
          local dx2 = x - p._lastPosPrev.x
          local dz2 = z - p._lastPosPrev.z
          local dist2 = math.sqrt(dx2*dx2 + dz2*dz2)
          if dist2 > 0 then
            p._sessionDistanceM = p._sessionDistanceM + dist2
          end
          if dist2 >= idleRadiusM then
            p._lastMoveMs = nowMs
          end
        end
        p._lastPosPrev = { x = x, z = z }

        -- Tracking sample (only if enabled)
        if trackEnabled and p._trackAccMs >= (trackIntervalSec * 1000) then
          p._trackAccMs = 0
          local mode = "foot"
          local vNow = self:getCurrentVehicle(playerObj)
          if vNow ~= nil then
            mode = "vehicle"
          end
          table.insert(p._trackPoints, { t = tostring(nowMs), x = x, z = z, mode = mode })
          -- rolling cap
          while #p._trackPoints > trackMaxPoints do
            table.remove(p._trackPoints, 1)
          end
          self._trackDirty = true
        end
      end

      -- Vehicle usage
      local vehicle = self:getCurrentVehicle(playerObj)
      local vehUniqueId = nil
      if vehicle ~= nil and vehicle.getUniqueId ~= nil then
        vehUniqueId = tostring(vehicle:getUniqueId())
      end

      if vehUniqueId ~= nil then
        local v = self.vehicles[vehUniqueId] or { byPlayer = {} }
        v.uniqueId = vehUniqueId
        v.name     = vehicle.getFullName ~= nil and tostring(vehicle:getFullName()) or (v.name or "Unknown")
        v.farmId   = tostring(vehicle.ownerFarmId or 0)
        v.totalMs  = (v.totalMs or 0) + tickMs

        local moving = self:isVehicleMoving(vehicle, dtSec)
        if moving then
          v.movingMs = (v.movingMs or 0) + tickMs
          isActive = true -- vozi => nije AFK
        else
          v.idleMs = (v.idleMs or 0) + tickMs
        end

        -- per player u tom vozilu
        v.byPlayer[puid] = v.byPlayer[puid] or {}
        local vp = v.byPlayer[puid]
        vp.id = uid
        vp.nickname = p.nickname
        vp.totalMs  = (vp.totalMs or 0) + tickMs
        if moving then
          vp.movingMs = (vp.movingMs or 0) + tickMs
        else
          vp.idleMs = (vp.idleMs or 0) + tickMs
        end
        vp.lastUsedAt = tostring(nowMs)

        self.vehicles[vehUniqueId] = v
      end

      -- Session activity counters (for Discord)
      if isActive then
        p._sessionActiveMs = (p._sessionActiveMs or 0) + tickMs
        p._lastMoveMs = nowMs -- vehicle moving counts as activity too
      else
        p._sessionIdleMs = (p._sessionIdleMs or 0) + tickMs
      end

      -- AFK kick (server-side)
      if idleKickEnabled and p._lastMoveMs ~= nil then
        local idleForMs = nowMs - p._lastMoveMs
        local warn1Ms = warn1 * 60 * 1000
        local warn2Ms = warn2 * 60 * 1000
        local kickMs  = idleKickMinutes * 60 * 1000

        if warn1Ms > 0 and idleForMs >= warn1Ms and not p._warned1 then
          p._warned1 = true
          Logging.info(string.format("[FSG_Companion] AFK warn1: %s (%s min idle)", tostring(p.nickname), tostring(warn1)))
        end
        if warn2Ms > 0 and idleForMs >= warn2Ms and not p._warned2 then
          p._warned2 = true
          Logging.info(string.format("[FSG_Companion] AFK warn2: %s (%s min idle)", tostring(p.nickname), tostring(warn2)))
        end

        if idleForMs >= kickMs and not p._kickedForAfk then
          p._kickedForAfk = true
          Logging.info(string.format("[FSG_Companion] AFK kick: %s (%s min idle)", tostring(p.nickname), tostring(idleKickMinutes)))
          -- Best effort kick (API differs by game build). Keep it safe.
          -- Use p.id (server slot ID) for the kick API, not puid (platform ID)
          local kickId = p.id or uid
          local ok = false
          if self.mission ~= nil and self.mission.userManager ~= nil then
            if self.mission.userManager.kickUser ~= nil then
              ok = pcall(function() self.mission.userManager:kickUser(tonumber(kickId) or kickId) end)
            elseif self.mission.userManager.removeUser ~= nil then
              ok = pcall(function() self.mission.userManager:removeUser(tonumber(kickId) or kickId) end)
            end
          end
          if not ok and g_farmManager ~= nil then
            pcall(function() g_farmManager:removeUserFromFarm(tonumber(kickId) or kickId) end)
          end

          -- Add session history entry (so bot can show it)
          self:pushSessionHistory({
            id = tostring(p.id or puid),
            nickname = tostring(p.nickname or puid),
            startedAtMs = tostring(p._sessionStartMs or nowMs),
            endedAtMs = tostring(nowMs),
            distanceM = tostring(p._sessionDistanceM or 0),
            activeMs = tostring(p._sessionActiveMs or 0),
            idleMs = tostring(p._sessionIdleMs or 0),
            reason = "AFK_KICK"
          })
          self._trackDirty = true
          self:exportTrackingToOutbox(true)
        end
      end

      -- AFK tracking
      p._lastActiveMs = p._lastActiveMs or nowMs
      if isActive then
        p._lastActiveMs = nowMs
      end
      local inactiveFor = nowMs - p._lastActiveMs
      if inactiveFor >= RuntimeStats.AFK_TIMEOUT_MS then
        p.totalAfkMs = (p.totalAfkMs or 0) + tickMs
      end

      p.lastSeenAtMs = nowMs
      self.players[puid] = p
    end
  end

  -- Detect disconnects (last online) + session summary
  for prevPuid, _ in pairs(self._lastConnected) do
    if not connectedNow[prevPuid] then
      local p = self.players[prevPuid]
      if p ~= nil then
        p.lastOnlineAt = tostring(nowMs)

        -- push session summary (leave)
        self:pushSessionHistory({
          id = tostring(p.id or prevPuid),
          nickname = tostring(p.nickname or prevPuid),
          startedAtMs = tostring(p._sessionStartMs or nowMs),
          endedAtMs = tostring(nowMs),
          distanceM = tostring(p._sessionDistanceM or 0),
          activeMs = tostring(p._sessionActiveMs or 0),
          idleMs = tostring(p._sessionIdleMs or 0),
          reason = "LEAVE"
        })

        -- reset per-session counters (next join creates new session)
        p._sessionStartMs = nil
        p._sessionDistanceM = 0
        p._sessionActiveMs = 0
        p._sessionIdleMs = 0
        p._trackPoints = {}
        p._trackAccMs = 0
        p._warned1 = nil
        p._warned2 = nil
        p._kickedForAfk = nil
        p._lastPosPrev = nil
      end
      self._trackDirty = true
    end
  end

  -- periodic export to outbox (tracking + sessionHistory)
  if trackEnabled then
    self._trackExportAccMs = (self._trackExportAccMs or 0) + tickMs
    if self._trackExportAccMs >= RuntimeStats.TRACK_EXPORT_INTERVAL_MS then
      self._trackExportAccMs = 0
      if self._trackDirty then
        self:exportTrackingToOutbox(false)
        self._trackDirty = false
      end
    end
  end

  self._lastConnected = connectedNow
end

-- Spremi XML u savegame (poziva se u onSaveComplete)
function RuntimeStats:saveToSavegame()
  local folder = self:getSavegameFolder()
  if folder == nil then return end

  -- playerTimeStats.xml
  local pFile = folder .. "/playerTimeStats.xml"
  local pXml = XMLFile.create("playerTimeStats", pFile, "playerTimeStats")
  if pXml ~= nil then
    pXml:setInt("playerTimeStats#version", 2)
    local idx = 0
    for _, p in pairs(self.players) do
      local key = string.format("playerTimeStats.player(%d)", idx)
      pXml:setString(key .. "#id", tostring(p.id or ""))
      if p.nickname ~= nil then pXml:setString(key .. "#nickname", tostring(p.nickname)) end
      if p.uniqueUserId ~= nil then pXml:setString(key .. "#uniqueUserId", tostring(p.uniqueUserId)) end
      if p.farmId ~= nil then pXml:setString(key .. "#farmId", tostring(p.farmId)) end
      pXml:setString(key .. "#totalOnlineMs", tostring(p.totalOnlineMs or 0))
      pXml:setString(key .. "#totalAfkMs", tostring(p.totalAfkMs or 0))
      if p.lastOnlineAt ~= nil then pXml:setString(key .. "#lastOnlineAt", tostring(p.lastOnlineAt)) end
      if p.lastSeenAtMs ~= nil then pXml:setString(key .. "#lastSeenAtMs", tostring(p.lastSeenAtMs)) end
      idx = idx + 1
    end
    pXml:save()
    pXml:delete()
  end

  -- vehicleUsageStats.xml
  local vFile = folder .. "/vehicleUsageStats.xml"
  local vXml = XMLFile.create("vehicleUsageStats", vFile, "vehicleUsageStats")
  if vXml ~= nil then
    local vidx = 0
    for _, v in pairs(self.vehicles) do
      local vKey = string.format("vehicleUsageStats.vehicle(%d)", vidx)
      vXml:setString(vKey .. "#uniqueId", tostring(v.uniqueId or ""))
      if v.name ~= nil then vXml:setString(vKey .. "#name", tostring(v.name)) end
      if v.farmId ~= nil then vXml:setString(vKey .. "#farmId", tostring(v.farmId)) end
      vXml:setString(vKey .. "#totalMs", tostring(v.totalMs or 0))
      vXml:setString(vKey .. "#movingMs", tostring(v.movingMs or 0))
      vXml:setString(vKey .. "#idleMs", tostring(v.idleMs or 0))

      local pidx = 0
      if v.byPlayer ~= nil then
        for _, vp in pairs(v.byPlayer) do
          local pKey = string.format(vKey .. ".player(%d)", pidx)
          vXml:setString(pKey .. "#id", tostring(vp.id or ""))
          if vp.nickname ~= nil then vXml:setString(pKey .. "#nickname", tostring(vp.nickname)) end
          vXml:setString(pKey .. "#totalMs", tostring(vp.totalMs or 0))
          vXml:setString(pKey .. "#movingMs", tostring(vp.movingMs or 0))
          vXml:setString(pKey .. "#idleMs", tostring(vp.idleMs or 0))
          if vp.lastUsedAt ~= nil then vXml:setString(pKey .. "#lastUsedAt", tostring(vp.lastUsedAt)) end
          pidx = pidx + 1
        end
      end
      vidx = vidx + 1
    end
    vXml:save()
    vXml:delete()
  end
end


-- Keep last N session history items
function RuntimeStats:pushSessionHistory(item)
  self.sessionHistory = self.sessionHistory or {}
  table.insert(self.sessionHistory, 1, item) -- newest first
  while #self.sessionHistory > 50 do
    table.remove(self.sessionHistory)
  end
end

function RuntimeStats:getOutboxFolder()
  return getUserProfileAppPath() .. "modSettings/" .. ((FSGSettings and FSGSettings.modName) or g_currentModName or "FS25_FSG_Companion") .. "/commands/outbox"
end

-- Write playerTracks.xml + playerSessionHistory.xml to outbox
-- forceNow=true => write immediately
function RuntimeStats:exportTrackingToOutbox(forceNow)
  if g_server == nil or g_dedicatedServer == nil then return end
  local outbox = self:getOutboxFolder()
  if outbox == nil or outbox == "" then return end

  -- playerTracks.xml
  local tracksFile = outbox .. "/playerTracks.xml"
  local tracksXml = XMLFile.create("playerTracks", tracksFile, "playerTracks")
  if tracksXml ~= nil then
    local idx = 0
    for _, p in pairs(self.players) do
      if p ~= nil and p._trackPoints ~= nil and #p._trackPoints > 0 then
        local key = string.format("playerTracks.player(%d)", idx)
        tracksXml:setString(key .. "#id", tostring(p.id or ""))
        tracksXml:setString(key .. "#uniqueUserId", tostring(p.uniqueUserId or ""))
        tracksXml:setString(key .. "#nickname", tostring(p.nickname or ""))
        tracksXml:setString(key .. "#sessionStartMs", tostring(p._sessionStartMs or ""))
        tracksXml:setString(key .. "#lastMoveMs", tostring(p._lastMoveMs or ""))
        tracksXml:setString(key .. "#distanceM", tostring(p._sessionDistanceM or 0))
        tracksXml:setString(key .. "#activeMs", tostring(p._sessionActiveMs or 0))
        tracksXml:setString(key .. "#idleMs", tostring(p._sessionIdleMs or 0))

        local pIdx = 0
        for _, pt in ipairs(p._trackPoints) do
          local pk = string.format("%s.point(%d)", key, pIdx)
          tracksXml:setString(pk .. "#t", tostring(pt.t or ""))
          tracksXml:setFloat(pk .. "#x", pt.x or 0)
          tracksXml:setFloat(pk .. "#z", pt.z or 0)
          tracksXml:setString(pk .. "#mode", tostring(pt.mode or ""))
          pIdx = pIdx + 1
        end
        idx = idx + 1
      end
    end
    tracksXml:save()
    tracksXml:delete()
  end

  -- playerSessionHistory.xml
  local histFile = outbox .. "/playerSessionHistory.xml"
  local histXml = XMLFile.create("playerSessionHistory", histFile, "playerSessionHistory")
  if histXml ~= nil then
    local hIdx = 0
    for _, s in ipairs(self.sessionHistory or {}) do
      local key = string.format("playerSessionHistory.session(%d)", hIdx)
      histXml:setString(key .. "#id", tostring(s.id or ""))
      histXml:setString(key .. "#nickname", tostring(s.nickname or ""))
      histXml:setString(key .. "#startedAtMs", tostring(s.startedAtMs or ""))
      histXml:setString(key .. "#endedAtMs", tostring(s.endedAtMs or ""))
      histXml:setString(key .. "#distanceM", tostring(s.distanceM or "0"))
      histXml:setString(key .. "#activeMs", tostring(s.activeMs or "0"))
      histXml:setString(key .. "#idleMs", tostring(s.idleMs or "0"))
      histXml:setString(key .. "#reason", tostring(s.reason or "LEAVE"))
      hIdx = hIdx + 1
      if hIdx >= 50 then break end
    end
    histXml:save()
    histXml:delete()
  end
end
