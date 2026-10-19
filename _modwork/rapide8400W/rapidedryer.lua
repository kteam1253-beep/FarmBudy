RapideDryer = {}

function RapideDryer.prerequisitesPresent(specializations)
    return SpecializationUtil.hasSpecialization(ForageWagon, specializations)
end

function RapideDryer.registerFunctions(vehicleType)
    SpecializationUtil.registerFunction(vehicleType, "setDryerEnabled", RapideDryer.setDryerEnabled)
    SpecializationUtil.registerFunction(vehicleType, "updateDryerActionEventText", RapideDryer.updateDryerActionEventText)
end

function RapideDryer.registerOverwrittenFunctions(vehicleType)
    SpecializationUtil.registerOverwrittenFunction(vehicleType, "addFillUnitFillLevel", RapideDryer.addFillUnitFillLevel)
end

function RapideDryer.registerEventListeners(vehicleType)
    SpecializationUtil.registerEventListener(vehicleType, "onLoad", RapideDryer)
    SpecializationUtil.registerEventListener(vehicleType, "onReadStream", RapideDryer)
    SpecializationUtil.registerEventListener(vehicleType, "onWriteStream", RapideDryer)
    SpecializationUtil.registerEventListener(vehicleType, "onReadUpdateStream", RapideDryer)
    SpecializationUtil.registerEventListener(vehicleType, "onWriteUpdateStream", RapideDryer)
    SpecializationUtil.registerEventListener(vehicleType, "onRegisterActionEvents", RapideDryer)
end

function RapideDryer:onLoad(savegame)
    local spec = {}
    spec.isEnabled = false
    spec.actionEvents = {}
    spec.dirtyFlag = self:getNextDirtyFlag()
    self.spec_rapideDryer = spec
end

function RapideDryer:onReadStream(streamId, connection)
    local spec = self.spec_rapideDryer
    spec.isEnabled = streamReadBool(streamId)
end

function RapideDryer:onWriteStream(streamId, connection)
    local spec = self.spec_rapideDryer
    streamWriteBool(streamId, spec.isEnabled)
end

function RapideDryer:onReadUpdateStream(streamId, timestamp, connection)
    local spec = self.spec_rapideDryer
    if streamReadBool(streamId) then
        spec.isEnabled = streamReadBool(streamId)
        self:updateDryerActionEventText()
    end
end

function RapideDryer:onWriteUpdateStream(streamId, connection, dirtyMask)
    local spec = self.spec_rapideDryer
    if connection:getIsServer() and bitAND(dirtyMask, spec.dirtyFlag) ~= 0 then
        streamWriteBool(streamId, true)
        streamWriteBool(streamId, spec.isEnabled)
    else
        streamWriteBool(streamId, false)
    end
end

function RapideDryer:onRegisterActionEvents(isActiveForInput, isActiveForInputIgnoreSelection)
    if not self.isClient then
        return
    end

    local spec = self.spec_rapideDryer
    self:clearActionEventsTable(spec.actionEvents)

    if isActiveForInputIgnoreSelection then
        local _, actionEventId = self:addActionEvent(spec.actionEvents, InputAction.RAPIDE_DRYER_TOGGLE, self, RapideDryer.actionEventToggleDryer, false, true, false, true, nil)
        if actionEventId ~= nil then
            g_inputBinding:setActionEventText(actionEventId, g_i18n:getText("action_rapide_toggleDryer", self.customEnvironment))
            g_inputBinding:setActionEventTextPriority(actionEventId, GS_PRIO_HIGH)
            self:updateDryerActionEventText()
        end
    end
end

function RapideDryer:actionEventToggleDryer(actionName, inputValue, callbackState, isAnalog)
    self:setDryerEnabled(not self.spec_rapideDryer.isEnabled, true)
end

function RapideDryer:setDryerEnabled(state, noEventSend)
    local spec = self.spec_rapideDryer
    if spec.isEnabled == state then
        return
    end

    spec.isEnabled = state
    self:updateDryerActionEventText()

    if self.isServer then
        self:raiseDirtyFlags(spec.dirtyFlag)
    end

    if self.isClient and g_currentMission ~= nil then
        local textKey = state and "info_rapide_dryerOn" or "info_rapide_dryerOff"
        g_currentMission:addGameNotification(g_i18n:getText(textKey, self.customEnvironment), 5000)
    end
end

function RapideDryer:updateDryerActionEventText()
    local spec = self.spec_rapideDryer
    if not self.isClient or spec.actionEvents == nil then
        return
    end

    local textKey = spec.isEnabled and "info_rapide_dryerOn" or "info_rapide_dryerOff"
    local stateText = g_i18n:getText(textKey, self.customEnvironment)
    for _, actionEvent in pairs(spec.actionEvents) do
        g_inputBinding:setActionEventTextVisibility(actionEvent.actionEventId, true)
        g_inputBinding:setActionEventText(actionEvent.actionEventId, string.format("%s (%s)", g_i18n:getText("action_rapide_toggleDryer", self.customEnvironment), stateText))
    end
end

function RapideDryer:addFillUnitFillLevel(superFunc, farmId, fillUnitIndex, fillLevelDelta, fillTypeIndex, toolType, fillPositionData, extraAttributes)
    local spec = self.spec_rapideDryer
    local forageSpec = self.spec_forageWagon

    if spec ~= nil and forageSpec ~= nil and spec.isEnabled and fillLevelDelta > 0 and fillUnitIndex == forageSpec.fillUnitIndex then
        local grassWindrow = FillType.GRASS_WINDROW or FillType.GRASS
        local hayWindrow = FillType.DRYGRASS_WINDROW or FillType.HAY

        if fillTypeIndex == grassWindrow then
            fillTypeIndex = hayWindrow
        end
    end

    return superFunc(self, farmId, fillUnitIndex, fillLevelDelta, fillTypeIndex, toolType, fillPositionData, extraAttributes)
end