rcDebug("FSGSettings Class")

FSGSettings = {}
FSGSettings.modName = g_currentModName
FSGSettings.modDirectory = g_currentModDirectory
FSGSettings.baseXmlKey = "FSGSettings"
FSGSettings.xmlKey = FSGSettings.baseXmlKey.."."

local FSGSettings_mt = Class(FSGSettings, Event)

InitEventClass(FSGSettings, "FSGSettings")

function FSGSettings.new(mission, i18n, modDirectory, modName)
  rcDebug("FSGS-New")
  local self = setmetatable({}, FSGSettings_mt)
  self.mission                = mission
  self.i18n                   = i18n
  self.modDirectory           = modDirectory
  self.modName                = modName
  self.isServer               = g_currentMission:getIsServer()
  self.justSetFalse           = false
  self.speedFix               = false
  self.setValueTimerFrequency = 60
  self.ServerUpdate           = false
  self.ServerHour             = 0
  self.ServerMinCleanUTC      = 0
  self.TimeSpeed              = 1
  self.actionEventId          = nil
  self.settingsLastModTime    = nil
  self.forceNextUpdate        = true
  self.firstRunDone           = false
  self.correctionStartTime    = nil
  self.lastSyncNotiTime       = nil
  self.lastFarmExportTime     = nil

  -- Load mod default settings
  self.settings = FS25PrefSaver:new(
    "FS25_FSG_Companion",
    "CompanionSettings.xml",
    false,
    {
      dismissWorkers          = {true, "bool"},
      inboxActive             = {true, "bool"},
      paintAnywhere           = {false, "bool"},
      limitsEnabled           = {false, "bool"},
      hireLimit               = {3, "int"},
      maxMissions             = {3, "int"},
      husbandryLimit          = {3, "int"},
      productionPoints        = {3, "int"},
      sellingPoints           = {2, "int"},
      farmHouses              = {2, "int"},
      generators              = {2, "int"},
      gardenSheds             = {21, "int"},
      floodLighting           = {21, "int"},
      otherPlaceables         = {6, "int"},
      progressNoti            = {true, "bool"},
      timeSyncEnable          = {true, "bool"},
      serverOffset            = {1, "int"},
      timeFixHour             = {1, "int"},
      autoSetTime             = {true, "bool"},
      transactionId           = {0, "int"},
      coopLimitsEnabled       = {false, "bool"},
      coopMinCruiseSpeed      = {3, "int"},
      coopMinCruiseMin        = {3, "int"},
      disableSleep            = {true, "bool"},
      disableBorrowEquipment  = {false, "bool"},
      placeableGreenhouses    = {2, "int"},
      targetTimeEnabled       = {false, "bool"},
      targetTimeHour          = {1, "int"},
      targetTimeMinute        = {1, "int"},
-- Player tracking (for Discord map + session analytics)
enablePlayerTracking      = {true, "bool"},
trackingIntervalSec       = {10, "int"},     -- sampling interval (seconds)
trackingMaxPoints         = {600, "int"},    -- rolling cap per player per session
trackingIdleKickEnabled   = {true, "bool"},
trackingIdleKickMinutes   = {60, "int"},
trackingIdleRadiusM       = {5, "int"},      -- considered "moved" if > radius
trackingWarnMinutes1      = {45, "int"},
trackingWarnMinutes2      = {55, "int"},
    },
		nil,
		nil
  )

	return self
end

-- Run on map load
-- FS25 - There is a new way to load menus.  Will have to come back to this.
function FSGSettings:loadMap(filename)
  rcDebug(" Info: FSGS-loadMap")

        self.settings:loadSettings()
        self.settings:saveSettings()
  if lfs ~= nil then
    self.settingsLastModTime = lfs.attributes(self.settings:getXMLFileName(), "modification")
  end

  local FSGInfoFrame = FSGSettingsGuiInfoFrame:new(nil, g_i18n)
  -- local FSGToolsFrame = FSGSettingsGuiToolsFrame:new(nil, g_i18n)
  local FSGSettingsFrame = FSGSettingsGuiSettingsFrame:new(nil, g_i18n)
  local FSGTimeSyncFrame = FSGSettingsGuiTimeSyncFrame:new(nil, g_i18n)
  -- local FSGFarmTransactionsFrame = FSGSettingsFarmTransactionsFrame:new(nil, g_i18n)

  g_gui:loadProfiles(FSGSettings.modDirectory .. "gui/guiProfiles.xml")

  FSGSettings.gui = FSGSettingsGui:new(g_messageCenter, g_i18n, g_inputBinding)

  g_gui:loadGui(FSGSettings.modDirectory .. "gui/FSGSettingsGuiInfoFrame.xml", "FSGSettingsGuiInfoFrame", FSGInfoFrame, true)
  -- g_gui:loadGui(FSGSettings.modDirectory .. "gui/FSGSettingsGuiToolsFrame.xml", "FSGSettingsGuiToolsFrame", FSGToolsFrame, true)
  g_gui:loadGui(FSGSettings.modDirectory .. "gui/FSGSettingsGuiSettingsFrame.xml", "FSGSettingsGuiSettingsFrame", FSGSettingsFrame, true)
  g_gui:loadGui(FSGSettings.modDirectory .. "gui/FSGSettingsGuiTimeSyncFrame.xml", "FSGSettingsGuiTimeSyncFrame", FSGTimeSyncFrame, true)
  -- g_gui:loadGui(FSGSettings.modDirectory .. "gui/FSGSettingsFarmTransactionsFrame.xml", "FSGSettingsFarmTransactionsFrame", FSGFarmTransactionsFrame, true)
  g_gui:loadGui(FSGSettings.modDirectory .. "gui/FSGSettingsGui.xml", "FSGSettingsGui", FSGSettings.gui)

  -- Register the FSG menu action once the GUI files are loaded
  self:updateActionEvents()

end

-- Register Player Interaction
function FSGSettings:updateActionEvents()
    -- Only clients, never dedi
    if g_isDedicatedServer or g_inputBinding == nil then
        return
    end

    if g_currentMission == nil or not g_currentMission:getIsClient() then
        return
    end

    -- If we had a previous action event, remove it first
    if self.actionEventId ~= nil and g_inputBinding.removeActionEvent ~= nil then
        g_inputBinding:removeActionEvent(self.actionEventId)
        self.actionEventId = nil
    end

    local _, actionEventId = g_inputBinding:registerActionEvent(
        "FSG_MENU",
        self,
        FSGSettings.actionAdditionalInfo_openGui,
        false,  -- triggerDown
        true,   -- triggerUp
        false,  -- triggerAlways
        true    -- startActive
    )

    if actionEventId ~= nil then
        g_inputBinding:setActionEventTextPriority(actionEventId, GS_PRIO_VERY_LOW)
        g_inputBinding:setActionEventText(actionEventId, g_i18n:getText("FSG_MENU"))
        self.actionEventId = actionEventId
    end
end


function FSGSettings:removeActionEvents()
    if self.actionEventId ~= nil then
        if g_inputBinding ~= nil and g_inputBinding.removeActionEvent ~= nil then
            g_inputBinding:removeActionEvent(self.actionEventId)
        end
        self.actionEventId = nil
    end
end


-- Load the gui
function FSGSettings:actionAdditionalInfo_openGui(actionName, keyStatus, arg3, arg4, arg5)
  rcDebug(" Info: FSGS-actionAdditionalInfo_openGui")
  if g_gui.currentGui == nil then
    -- Load the gui
    g_gui:showGui("FSGSettingsGui")
  end
end

function FSGSettings:update(dt)
  -- Register the button input
  FSGSettings:updateActionEvents()

  -- Periodic farmPlayers export to outbox (every 2 min, independent of save)
  if g_server ~= nil and g_dedicatedServer ~= nil and FSGSettings:singleServerCheck() then
    local now = getTime()
    if self.lastFarmExportTime == nil or (now - self.lastFarmExportTime) > 120000 then
      self.lastFarmExportTime = now
      local ok, err = pcall(function()
        onSave.getFarmPlayers()
        onSave:copySaveFileToOutbox("farmPlayers.xml")
      end)
      if not ok then
        rcErrorLog("farmPlayersExport", tostring(err))
      end
    end
  end

  -- Periodic error log export to outbox (every 60s)
  if g_server ~= nil and g_dedicatedServer ~= nil then
    local now2 = getTime()
    if g_modErrorLogLastExport == nil or (now2 - g_modErrorLogLastExport) > 60000 then
      g_modErrorLogLastExport = now2
      pcall(rcExportErrorLog)
    end
  end

  -- Set Defaults
  local TimeDiff = 0
  local TimeSpeed = 1

  -- check if within the loopCount, and if server or single player.  Don't run on server clients.

  -- Force an immediate check on first run after map load or when settings change
  local forceNow = false
  if self.forceNextUpdate and FSGSettings:singleServerCheck() then
    self.forceNextUpdate = false
    forceNow = true
  end

  -- Run first check shortly after map load (within ~2 seconds)
  if not self.firstRunDone and g_updateLoopIndex > 120 and FSGSettings:singleServerCheck() then
    self.firstRunDone = true
    forceNow = true
  end

  -- If the game timescale IS NOT 1x then run the time adjustments every 60 frames.
  -- If the game timescale IS     1x then run the time adjustments every 2 minutes (instead of 10).
  if forceNow
      or (g_currentMission.missionInfo.timeScale ~= 1 and g_updateLoopIndex % self.setValueTimerFrequency == 0 and FSGSettings:singleServerCheck())
      or (g_updateLoopIndex % ((self.setValueTimerFrequency*60)*2) == 0 and FSGSettings:singleServerCheck()) then

    local doReload = true
    if lfs ~= nil then
      local modTime = lfs.attributes(self.settings:getXMLFileName(), "modification")
      if modTime ~= nil then
        doReload = (self.settingsLastModTime == nil or self.settingsLastModTime ~= modTime)
        self.settingsLastModTime = modTime
      end
    end

    if doReload then
      self.settings:loadSettings()
    end
    if self.settings:getValue("timeSyncEnable") == false then
      -- Check to see if just set as false.  if so then set speed to 1
      if self.justSetFalse == true then
        if FSGSettings:isSinglePlayer() then
          g_currentMission.missionInfo.timeScale = 1
        else
          g_currentMission:setTimeScale(1);
        end
        self.justSetFalse = false
      end
      return
    else
      self.justSetFalse = true
    end
    -- Check if target time mode is enabled
    local targetTimeEnabled = self.settings:getValue("targetTimeEnabled")
    local ServerHour, ServerMinCleanUTC

    if targetTimeEnabled then
      -- Use manually set target time instead of server clock
      local tgtH = self.settings:getValue("targetTimeHour")
      local tgtM = self.settings:getValue("targetTimeMinute")
      ServerHour = (tgtH or 1) - 1           -- 1-based state -> 0-23
      ServerMinCleanUTC = ((tgtM or 1) - 1) * 5  -- 1-based state -> 0,5,10,...55
    else
      -- Get real wall-clock time using getDate() which is available on dedicated servers
      local timeStr = getDate("%H:%M")
      local colonPos = timeStr:find(":")
      ServerHour = tonumber(timeStr:sub(1, colonPos - 1)) or 0
      ServerMinCleanUTC = tonumber(timeStr:sub(colonPos + 1)) or 0
    end

    -- Setup the times so they work with game times
    local ServerMin = MathUtil.round(ServerMinCleanUTC / 60, 2)
    local ServerTime = ServerHour + ServerMin
    -- Set defaults for later changed vars
    local AlwaysRun = false
    local SetServerTime = 0
    -- Convert timeFixHour to a read able format
    local setTimeFixHour = self.settings:getValue("timeFixHour")
    local setServerOffset = self.settings:getValue("serverOffset") - 12
    local setAutoSetTime = self.settings:getValue("autoSetTime")
    -- Start the time fix process if enabled
    rcDebug("setTimeFixHour: " .. setTimeFixHour)
    local runTimeFixHour = 1
    if setTimeFixHour == 1 then
      AlwaysRun = true;
    else
      runTimeFixHour = setTimeFixHour
      rcDebug("runTimeFixHour: " .. runTimeFixHour)
    end
    -- get the current hour with offset if one is set (skip offset for target time mode)
    if not targetTimeEnabled and type(setServerOffset) == "number" and setServerOffset ~= 0 then
      rcDebug("FSGSettings:serverTimeBeforeOffset: " .. ServerHour + ServerMin)
      ServerHour = (ServerHour + setServerOffset);
      -- Normalize hour to 0-23 range after offset
      if ServerHour < 0 then ServerHour = ServerHour + 24 end
      if ServerHour >= 24 then ServerHour = ServerHour - 24 end
    end
    -- check if timeFixHour is set and if so then check if that time matches current time.  Stop script if not 0 or hour matches
    -- (skip this check for target time mode - always run)
    if not targetTimeEnabled and AlwaysRun == false and runTimeFixHour ~= tonumber(ServerHour) then
      rcDebug("FSGSettings:TimeFixHour not Always and ServerHour does not match TimeFixHour: " .. ServerHour .. "~=" .. runTimeFixHour)
      -- Set the speed to 1 just in case server was not done fixing the time.
      if self.speedFix == true then
        if FSGSettings:isSinglePlayer() then
          g_currentMission.missionInfo.timeScale = 1
        else
          g_currentMission:setTimeScale(1);
        end
        self.ServerUpdate = false -- Disable notifcation
        TimeSpeed = 1 -- Time scale speed
        self.speedFix = false
      end
      return
    end
    -- Get the game time for comparison 
    local GameHour = g_currentMission.environment.currentHour
    local GameMinute = g_currentMission.environment.currentMinute
    local GameMin = MathUtil.round(GameMinute / 60, 2)
    local GameTime = GameHour + GameMin
    -- Set the current server time with minutes added
    ServerTime = ServerHour + ServerMin;
    -- Check if ServerTime is greater than 24 and subtract if so so that it is not getting an invalid number
    if ServerTime > 24 then
      ServerTime = (ServerTime - 24)
    elseif ServerTime < 0 then
      ServerTime = (ServerTime + 24)
    end
    -- Time to set the game to if game is too far ahead of server time
    SetServerTime = ServerTime - 0.03

    -- Handle midnight rollover in BOTH directions
    local rolloverBuffer = 2 -- hours on either side of midnight
    local CompareServerTime = ServerTime
    local CompareGameTime = GameTime

    if GameTime > (24 - rolloverBuffer) and ServerTime < rolloverBuffer then
      -- Server just crossed midnight, game hasn't yet
      -- e.g. Game=23:00, Server=01:00 -> game is 2h behind
      CompareServerTime = ServerTime + 24
    elseif ServerTime > (24 - rolloverBuffer) and GameTime < rolloverBuffer then
      -- Game just crossed midnight, server hasn't yet
      -- e.g. Game=01:00, Server=23:00 -> game is 2h ahead
      CompareGameTime = GameTime + 24
    end

    -- TimeDiff > 0 = game is BEHIND server (need to catch up)
    -- TimeDiff < 0 = game is AHEAD of server (need to slow down)
    TimeDiff = MathUtil.round(CompareServerTime - CompareGameTime, 2)

    rcDebug("FSGSettings:SetServerTime: " .. SetServerTime)
    rcDebug("FSGSettings:ServerTime: " .. ServerTime)
    rcDebug("FSGSettings:GameTime: " .. GameTime)
    rcDebug("FSGSettings:TimeDiff: " .. TimeDiff)

    -- Set server time to global for notification use
    self.ServerHour = ServerHour
    self.ServerMinCleanUTC = ServerMinCleanUTC
    self.GameHour = GameHour
    self.GameMinute = GameMinute

    -- Helper to set time scale on both SP and MP
    local function setScale(scale)
      if FSGSettings:isSinglePlayer() then
        g_currentMission.missionInfo.timeScale = scale
      else
        g_currentMission:setTimeScale(scale)
      end
    end

    -- Track how long we've been in correction mode (non-1x speed)
    if TimeDiff > 0.03 or TimeDiff < -0.03 then
      if self.correctionStartTime == nil then
        self.correctionStartTime = getTime()
      end
    else
      self.correctionStartTime = nil
    end

    local correctionElapsedMs = self.correctionStartTime and (getTime() - self.correctionStartTime) or 0
    local correctionSec = correctionElapsedMs / 1000
    local MAX_CORRECTION_SEC = 900 -- 15 real minutes max in any correction mode

    -- Format helper for notifications
    local function fmtTime(h, m)
      return h .. ":" .. (m < 10 and "0" or "") .. m
    end

    -- ===== GAME IS BEHIND SERVER (TimeDiff > 0) - catch up =====
    -- consoleCommandSetDayTime going forward is safe (never skips a day)
    if TimeDiff > 0.33 then
      -- > 20 min behind: jump directly to server time
      rcDebug("FSGSettings: >20min behind, jumping directly to server time")
      g_currentMission.environment:consoleCommandSetDayTime(SetServerTime)
      setScale(1)
      self.correctionStartTime = nil
      self.ServerUpdate = false
      TimeSpeed = 1
      local jumpNoti = g_i18n:getText("title_realTimeSync_setInProgress") .. fmtTime(ServerHour, ServerMinCleanUTC)
      if self.isServer then
        g_server:broadcastEvent(FCSettingEvent.new(1, "realTimeSyncNoti", jumpNoti))
      else
        g_currentMission:addIngameNotification(FSBaseMission.INGAME_NOTIFICATION_INFO, jumpNoti)
      end

    elseif TimeDiff > 0.17 then
      -- 10-20 min behind: speed 30x (max safe speed)
      rcDebug("FSGSettings: 10-20min behind, speed x30")
      setScale(30)
      self.ServerUpdate = true
      TimeSpeed = 30

    elseif TimeDiff > 0.08 then
      -- 5-10 min behind: speed 15x
      rcDebug("FSGSettings: 5-10min behind, speed x15")
      setScale(15)
      self.ServerUpdate = true
      TimeSpeed = 15

    elseif TimeDiff > 0.03 then
      -- 2-5 min behind: speed 5x
      rcDebug("FSGSettings: 2-5min behind, speed x5")
      setScale(5)
      self.ServerUpdate = false
      TimeSpeed = 5

    -- ===== GAME IS AHEAD OF SERVER (TimeDiff < 0) - slow down =====
    -- NEVER use consoleCommandSetDayTime here! It always goes forward
    -- which would skip to the NEXT day at that hour.
    elseif TimeDiff < -0.03 then

      -- Safety: if stuck in correction for too long, give up and reset to 1x
      if correctionSec > MAX_CORRECTION_SEC then
        rcDebug("FSGSettings: correction timeout after " .. correctionSec .. "s, resetting to 1x")
        setScale(1)
        self.correctionStartTime = nil
        self.ServerUpdate = false
        TimeSpeed = 1
        -- Warn admin that sync timed out
        local timeoutNoti = g_i18n:getText("title_realTimeSync") .. ": sync timeout (" .. math.floor(correctionSec/60) .. "min), provjeri offset"
        if self.isServer then
          g_server:broadcastEvent(FCSettingEvent.new(1, "realTimeSyncNoti", timeoutNoti))
        else
          g_currentMission:addIngameNotification(FSBaseMission.INGAME_NOTIFICATION_INFO, timeoutNoti)
        end
      else
        -- Slow down to 0.5x and wait for server clock to catch up
        -- At 0.5x the gap closes by ~0.5h per real hour
        rcDebug("FSGSettings: game ahead by " .. string.format("%.1f", math.abs(TimeDiff)) .. "h, slowing to 0.5x")
        setScale(0.5)
        self.ServerUpdate = false
        TimeSpeed = 0.5
      end

    -- ===== WITHIN TOLERANCE (+-2 min) - keep at 1x =====
    elseif g_currentMission.missionInfo.timeScale ~= 1 then
      setScale(1)
      self.correctionStartTime = nil
      self.ServerUpdate = false
      self.lastSyncNotiTime = nil
      TimeSpeed = 1
    end
  end

  -- Persistent sync notification: show every 120 seconds while sync is active
  local syncActive = (TimeDiff > 0.03 or TimeDiff < -0.03)
  if syncActive and self.settings:getValue("progressNoti") then
    local now = getTime()
    if self.lastSyncNotiTime == nil or (now - self.lastSyncNotiTime) > 120000 then
      self.lastSyncNotiTime = now
      local diffMinutes = math.floor(math.abs(TimeDiff) * 60 + 0.5)
      local sign = TimeDiff > 0 and "-" or "+"
      local displayH = self.ServerHour or 0
      local displayM = self.ServerMinCleanUTC or 0
      local gameH = self.GameHour or 0
      local gameM = self.GameMinute or 0
      local notiText = string.format("Sync: Igra %02d:%02d -> Ciljano %02d:%02d | %s%dmin | %sx",
        gameH, gameM, displayH, displayM, sign, diffMinutes, TimeSpeed)
      if self.isServer then
        g_server:broadcastEvent(FCSettingEvent.new(1, "realTimeSyncNoti", notiText))
      else
        g_currentMission:addIngameNotification(FSBaseMission.INGAME_NOTIFICATION_INFO, notiText)
      end
    end
  elseif not syncActive then
    self.lastSyncNotiTime = nil
  end

  -- Track speed change for legacy notification flag
  if TimeDiff ~= 0 and TimeSpeed ~= self.TimeSpeed then
    self.TimeSpeed = TimeSpeed
    self.speedFix = true
  end
  self.ServerUpdate = false
end

-- Run on savegame
function FSGSettings:onSaveComplete()
  rcDebug(" Info: FSGS-onSaveComplete")

  g_fsgSettings.settings:saveSettings()

end

function FSGSettings:delete()
    if self.actionEventId ~= nil and g_inputBinding ~= nil then
        g_inputBinding:removeActionEvent(self.actionEventId)
        self.actionEventId = nil
    end
end


-- Disable the sleep stuffs
function FSGSettings:disableSleep()
  -- Check to see if sleep is disabled
  local canDisableSleep = g_fsgSettings.settings:getValue("disableSleep")
  if canDisableSleep ~= nil and canDisableSleep then
    return false
  else
    return not g_sleepManager.isSleeping
  end
end

-- Check if client is a server or single player
function FSGSettings:singleServerCheck()
  -- Check if server
  if g_currentMission:getIsServer() == true and g_currentMission:getIsClient() == true and g_dedicatedServer ~= nil and g_server ~= nil then 
    -- Multiplayer Server Host
    return true
  -- Check if single player
  elseif g_currentMission:getIsServer() == true and g_currentMission:getIsClient() == true and g_dedicatedServer == nil and g_server ~= nil then 
    -- Single player client
    return true
  else
    -- Client on dedicated server
    return false
  end
end

-- Check if single player
function FSGSettings:isSinglePlayer()
  if g_currentMission:getIsServer() == true and g_currentMission:getIsClient() == true and g_dedicatedServer == nil and g_server ~= nil then 
    return true
  else
    return false
  end
end

-- Refresh Settings Menus
function FSGSettings:refresh()
  if g_dedicatedServer == nil then
    FSGSettingsGuiSettingsFrame:updateSettings()
    FSGSettingsGuiTimeSyncFrame:updateSettings()
    FSGSettingsGuiToolsFrame:updateSettings()
  end
end

-- Gets transactionId for current command to help avoid duplicates
function FSGSettings:getTransactionId()
  -- Get current transactionId
  local lastTransactionId = g_fsgSettings.settings:getValue("transactionId")
  -- Generate the new transactionId
  local newTranansactionId = lastTransactionId + 1 or 1
  -- Update the transactionId
  rcDebug("FSGSettings:getTransactionId: " .. newTranansactionId)
  g_fsgSettings.settings:setValue("transactionId",newTranansactionId)
  g_fsgSettings.settings:saveSettings()
  -- Send out the new transaction id to everyone
  FCSettingEvent.sendEvent(4, "transactionId", newTranansactionId)
  return newTranansactionId
end

-- Event when player joins server
function FSGSettings:join()
  rcDebug("FSGSettings:join")
  -- Send settings to new client
  FCSettingEvent.sendEvent(2, "paintAnywhere", g_fsgSettings.settings:getValue("paintAnywhere"))
  FCSettingEvent.sendEvent(2, "dismissWorkers", g_fsgSettings.settings:getValue("dismissWorkers"))
  FCSettingEvent.sendEvent(2, "inboxActive", g_fsgSettings.settings:getValue("inboxActive"))
  FCSettingEvent.sendEvent(3, "hireLimit", g_fsgSettings.settings:getValue("hireLimit"))
  FCSettingEvent.sendEvent(3, "maxMissions", g_fsgSettings.settings:getValue("maxMissions"))
  FCSettingEvent.sendEvent(3, "husbandryLimit", g_fsgSettings.settings:getValue("husbandryLimit"))
  FCSettingEvent.sendEvent(3, "productionPoints", g_fsgSettings.settings:getValue("productionPoints"))
  FCSettingEvent.sendEvent(3, "sellingPoints", g_fsgSettings.settings:getValue("sellingPoints"))
  FCSettingEvent.sendEvent(3, "farmHouses", g_fsgSettings.settings:getValue("farmHouses"))
  FCSettingEvent.sendEvent(3, "generators", g_fsgSettings.settings:getValue("generators"))
  FCSettingEvent.sendEvent(3, "gardenSheds", g_fsgSettings.settings:getValue("gardenSheds"))
  FCSettingEvent.sendEvent(3, "floodLighting", g_fsgSettings.settings:getValue("floodLighting"))
  FCSettingEvent.sendEvent(3, "otherPlaceables", g_fsgSettings.settings:getValue("otherPlaceables"))
  FCSettingEvent.sendEvent(2, "progressNoti", g_fsgSettings.settings:getValue("progressNoti"))
  FCSettingEvent.sendEvent(2, "timeSyncEnable", g_fsgSettings.settings:getValue("timeSyncEnable"))
  FCSettingEvent.sendEvent(3, "serverOffset", g_fsgSettings.settings:getValue("serverOffset"))
  FCSettingEvent.sendEvent(3, "timeFixHour", g_fsgSettings.settings:getValue("timeFixHour"))
  FCSettingEvent.sendEvent(2, "autoSetTime", g_fsgSettings.settings:getValue("autoSetTime"))
  FCSettingEvent.sendEvent(4, "transactionId", g_fsgSettings.settings:getValue("transactionId"))
  FCSettingEvent.sendEvent(2, "coopLimitsEnabled", g_fsgSettings.settings:getValue("coopLimitsEnabled"))
  FCSettingEvent.sendEvent(3, "coopMinCruiseSpeed", g_fsgSettings.settings:getValue("coopMinCruiseSpeed"))
  FCSettingEvent.sendEvent(3, "coopMinCruiseMin", g_fsgSettings.settings:getValue("coopMinCruiseMin"))
  FCSettingEvent.sendEvent(2, "disableSleep", g_fsgSettings.settings:getValue("disableSleep"))
  FCSettingEvent.sendEvent(3, "placeableGreenhouses", g_fsgSettings.settings:getValue("placeableGreenhouses"))
  
end