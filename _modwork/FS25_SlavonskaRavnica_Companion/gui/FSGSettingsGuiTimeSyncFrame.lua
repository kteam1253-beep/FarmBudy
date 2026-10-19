--
-- FSG Settings - Settings Page
--

FSGSettingsGuiTimeSyncFrame = {}

local FSGSettingsGuiTimeSyncFrame_mt = Class(FSGSettingsGuiTimeSyncFrame, TabbedMenuFrameElement)

function FSGSettingsGuiTimeSyncFrame:new(subclass_mt, l10n)
    local self = FSGSettingsGuiTimeSyncFrame:superClass().new(nil, subclass_mt or FSGSettingsGuiTimeSyncFrame_mt)

    rcDebug("FSGSettingsGuiTimeSyncFrame-new")

    self.messageCenter      = g_messageCenter
    self.l10n               = l10n
    self.isMPGame           = g_currentMission.missionDynamicInfo.isMultiplayer
    self.isServer           = g_currentMission:getIsServer()

    return self
end


function FSGSettingsGuiTimeSyncFrame:copyAttributes(src)
    FSGSettingsGuiTimeSyncFrame:superClass().copyAttributes(self, src)

    self.ui   = src.ui
    self.l10n = src.l10n
end


function FSGSettingsGuiTimeSyncFrame:initialize()
    self.backButtonInfo = {inputAction = InputAction.MENU_BACK}
end


function FSGSettingsGuiTimeSyncFrame:onGuiSetupFinished()
    FSGSettingsGuiTimeSyncFrame:superClass().onGuiSetupFinished(self)

end


function FSGSettingsGuiTimeSyncFrame:delete()
    FSGSettingsGuiTimeSyncFrame:superClass().delete(self)
    self.messageCenter:unsubscribeAll(self)
end


function FSGSettingsGuiTimeSyncFrame:updateMenuButtons()


    self.menuButtonInfo = {}
    self.menuButtonInfo = {
        {
            inputAction = InputAction.MENU_BACK
        }
    }

    self:setMenuButtonInfoDirty()
end


function FSGSettingsGuiTimeSyncFrame:onFrameOpen()
    FSGSettingsGuiTimeSyncFrame:superClass().onFrameOpen(self)

    rcDebug("FSGSettingsGuiTimeSyncFrame:onFrameOpen")

    -- Load Settings
    g_fsgSettings.settings:loadSettings()

    self.isOpening = true

    -- Reload the fsg settings
    self:updateSettings()

		self.companionSettingsLayout:setVisible(true)
		self.companionSettingsLayout:invalidateLayout()

    -- Alternates the background colors
    local set = true
    for _, tableRow in pairs(self.companionSettingsLayout.elements) do
      if tableRow.name == "sectionHeader" or tableRow.name == "fsgSettingsNoPermissionText" then
        set = true
      elseif tableRow:getIsVisible() then
        local color = InGameMenuSettingsFrame.COLOR_ALTERNATING[set]
        tableRow:setImageColor(nil, unpack(color))
        set = not set
      end
    end

    self.fsgSettingsNoPermissionText:setVisible(not g_currentMission:getIsServer() and not g_currentMission.isMasterUser)

end


function FSGSettingsGuiTimeSyncFrame:onRefreshEvent()

end


function FSGSettingsGuiTimeSyncFrame:onFrameClose()
    FSGSettingsGuiTimeSyncFrame:superClass().onFrameClose(self)

    self.messageCenter:unsubscribeAll(self)
end

function FSGSettingsGuiTimeSyncFrame:updateSettings()
  rcDebug("FSGSettingsGuiTimeSyncFrame:updateSettings")

  local timeSyncEnable = g_fsgSettings.settings:getValue("timeSyncEnable")
  self.updateTimeSyncEnable:setIsChecked(timeSyncEnable, self.isOpening)
  self.updateTimeSyncEnable:setDisabled(not g_currentMission:getIsServer() and not g_currentMission.isMasterUser)
  
  local serverOffset = g_fsgSettings.settings:getValue("serverOffset")
  self.updateTimeSyncServerOffset:setState(serverOffset)
  self.updateTimeSyncServerOffset:setDisabled(not g_currentMission:getIsServer() and not g_currentMission.isMasterUser)

  local timeFixHour = g_fsgSettings.settings:getValue("timeFixHour")
  self.updateTimeSyncTimeFixHour:setState(timeFixHour)
  self.updateTimeSyncTimeFixHour:setDisabled(not g_currentMission:getIsServer() and not g_currentMission.isMasterUser)

  local autoSetTime = g_fsgSettings.settings:getValue("autoSetTime")
  self.updateTimeSyncAutoSetTime:setIsChecked(autoSetTime, self.isOpening)
  self.updateTimeSyncAutoSetTime:setDisabled(not g_currentMission:getIsServer() and not g_currentMission.isMasterUser)

  local progressNoti = g_fsgSettings.settings:getValue("progressNoti")
  self.updateTimeSyncProgressNotification:setIsChecked(progressNoti, self.isOpening)
  self.updateTimeSyncProgressNotification:setDisabled(not g_currentMission:getIsServer() and not g_currentMission.isMasterUser)

  local targetTimeEnabled = g_fsgSettings.settings:getValue("targetTimeEnabled")
  self.updateTargetTimeEnabled:setIsChecked(targetTimeEnabled, self.isOpening)
  self.updateTargetTimeEnabled:setDisabled(not g_currentMission:getIsServer() and not g_currentMission.isMasterUser)

  local targetTimeHour = g_fsgSettings.settings:getValue("targetTimeHour")
  self.updateTargetTimeHour:setState(targetTimeHour)
  self.updateTargetTimeHour:setDisabled(not g_currentMission:getIsServer() and not g_currentMission.isMasterUser)

  local targetTimeMinute = g_fsgSettings.settings:getValue("targetTimeMinute")
  self.updateTargetTimeMinute:setState(targetTimeMinute)
  self.updateTargetTimeMinute:setDisabled(not g_currentMission:getIsServer() and not g_currentMission.isMasterUser)

end

function FSGSettingsGuiTimeSyncFrame:onClickUpdateTimeSyncEnable(state)
  rcDebug("FSGSettingsGuiTimeSyncFrame:onClickUpdateTimeSyncEnable")
  local boolVal = state == CheckedOptionElement.STATE_CHECKED
  g_fsgSettings.settings:setValue("timeSyncEnable", boolVal)
  g_fsgSettings.settings:saveSettings()
  g_fsgSettings.forceNextUpdate = true
  if not self.isServer then
    -- Send setting data to the server
    rcDebug('FSGSettingsGuiTimeSyncFrame:onClickUpdateTimeSyncEnable: ')
    rcDebug(boolVal)
    FCSettingEvent.sendEvent(2, "timeSyncEnable", boolVal)
  end
  g_currentMission:addIngameNotification(FSBaseMission.INGAME_NOTIFICATION_INFO, g_i18n:getText("title_realTimeSync") .. ": " .. (boolVal and "ON" or "OFF"))
end

function FSGSettingsGuiTimeSyncFrame:onClickUpdateTimeSyncServerOffset(state)
  rcDebug("FSGSettingsGuiTimeSyncFrame:onClickUpdateTimeSyncServerOffset")
  g_fsgSettings.settings:setValue("serverOffset", state)
  g_fsgSettings.settings:saveSettings()
  g_fsgSettings.forceNextUpdate = true
  if not self.isServer then
    -- Send setting data to the server
    rcDebug('FSGSettingsGuiTimeSyncFrame:onClickUpdateTimeSyncServerOffset: ')
    rcDebug(state)
    FCSettingEvent.sendEvent(3, "serverOffset", state)
  end
  -- Show confirmation with the selected UTC offset
  local offsetVal = state - 12
  local sign = offsetVal >= 0 and "+" or ""
  g_currentMission:addIngameNotification(FSBaseMission.INGAME_NOTIFICATION_INFO, g_i18n:getText("title_realTimeSync") .. ": UTC" .. sign .. offsetVal .. " saved")
end

function FSGSettingsGuiTimeSyncFrame:onClickUpdateTimeSyncTimeFixHour(state)
  rcDebug("FSGSettingsGuiTimeSyncFrame:onClickUpdateTimeSyncTimeFixHour")
  g_fsgSettings.settings:setValue("timeFixHour", state)
  g_fsgSettings.settings:saveSettings()
  g_fsgSettings.forceNextUpdate = true
  if not self.isServer then
    -- Send setting data to the server
    rcDebug('FSGSettingsGuiTimeSyncFrame:onClickUpdateTimeSyncTimeFixHour: ')
    rcDebug(state)
    FCSettingEvent.sendEvent(3, "timeFixHour", state)
  end
  local hourLabel = (state == 1) and "Uvijek" or tostring(state)
  g_currentMission:addIngameNotification(FSBaseMission.INGAME_NOTIFICATION_INFO, g_i18n:getText("title_realTimeSync") .. ": Fix hour = " .. hourLabel)
end

function FSGSettingsGuiTimeSyncFrame:onClickUpdateTimeSyncAutoSetTime(state)
  rcDebug("FSGSettingsGuiTimeSyncFrame:onClickUpdateTimeSyncAutoSetTime")
  local boolVal = state == CheckedOptionElement.STATE_CHECKED
  g_fsgSettings.settings:setValue("autoSetTime", boolVal)
  g_fsgSettings.settings:saveSettings()
  if not self.isServer then
    -- Send setting data to the server
    rcDebug('FSGSettingsGuiTimeSyncFrame:onClickUpdateTimeSyncAutoSetTime: ')
    rcDebug(boolVal)
    FCSettingEvent.sendEvent(2, "autoSetTime", boolVal)
  end
  g_currentMission:addIngameNotification(FSBaseMission.INGAME_NOTIFICATION_INFO, g_i18n:getText("title_realTimeSync") .. ": Auto set time = " .. (boolVal and "ON" or "OFF"))
end

function FSGSettingsGuiTimeSyncFrame:onClickUpdateTimeSyncProgressNotification(state)
  rcDebug("FSGSettingsGuiTimeSyncFrame:onClickUpdateTimeSyncProgressNotification")
  local boolVal = state == CheckedOptionElement.STATE_CHECKED
  g_fsgSettings.settings:setValue("progressNoti", boolVal)
  g_fsgSettings.settings:saveSettings()
  if not self.isServer then
    -- Send setting data to the server
    rcDebug('FSGSettingsGuiTimeSyncFrame:onClickUpdateTimeSyncProgressNotification: ')
    rcDebug(boolVal)
    FCSettingEvent.sendEvent(2, "progressNoti", boolVal)
  end
  g_currentMission:addIngameNotification(FSBaseMission.INGAME_NOTIFICATION_INFO, g_i18n:getText("title_realTimeSync") .. ": Notifikacije = " .. (boolVal and "ON" or "OFF"))
end

function FSGSettingsGuiTimeSyncFrame:onClickUpdateTargetTimeEnabled(state)
  rcDebug("FSGSettingsGuiTimeSyncFrame:onClickUpdateTargetTimeEnabled")
  local boolVal = state == CheckedOptionElement.STATE_CHECKED
  g_fsgSettings.settings:setValue("targetTimeEnabled", boolVal)
  g_fsgSettings.settings:saveSettings()
  g_fsgSettings.forceNextUpdate = true
  if not self.isServer then
    FCSettingEvent.sendEvent(2, "targetTimeEnabled", boolVal)
  end
  g_currentMission:addIngameNotification(FSBaseMission.INGAME_NOTIFICATION_INFO, g_i18n:getText("title_realTimeSync") .. ": Ciljano vrijeme = " .. (boolVal and "ON" or "OFF"))
end

function FSGSettingsGuiTimeSyncFrame:onClickUpdateTargetTimeHour(state)
  rcDebug("FSGSettingsGuiTimeSyncFrame:onClickUpdateTargetTimeHour")
  g_fsgSettings.settings:setValue("targetTimeHour", state)
  g_fsgSettings.settings:saveSettings()
  g_fsgSettings.forceNextUpdate = true
  if not self.isServer then
    FCSettingEvent.sendEvent(3, "targetTimeHour", state)
  end
  local hourVal = state - 1
  g_currentMission:addIngameNotification(FSBaseMission.INGAME_NOTIFICATION_INFO, g_i18n:getText("title_realTimeSync") .. ": Ciljani sat = " .. string.format("%02d", hourVal) .. ":00")
end

function FSGSettingsGuiTimeSyncFrame:onClickUpdateTargetTimeMinute(state)
  rcDebug("FSGSettingsGuiTimeSyncFrame:onClickUpdateTargetTimeMinute")
  g_fsgSettings.settings:setValue("targetTimeMinute", state)
  g_fsgSettings.settings:saveSettings()
  g_fsgSettings.forceNextUpdate = true
  if not self.isServer then
    FCSettingEvent.sendEvent(3, "targetTimeMinute", state)
  end
  local minVal = (state - 1) * 5
  g_currentMission:addIngameNotification(FSBaseMission.INGAME_NOTIFICATION_INFO, g_i18n:getText("title_realTimeSync") .. ": Ciljana minuta = " .. string.format("%02d", minVal))
end