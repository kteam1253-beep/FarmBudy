RefillImplementEvent = {}
local RefillImplementEvent_mt = Class(RefillImplementEvent, Event)

InitEventClass(RefillImplementEvent, "RefillImplementEvent")

function RefillImplementEvent.emptyNew()
    afmDebug(' Info: RefillImplementEvent:emptyNew')
    return Event.new(RefillImplementEvent_mt)
end

function RefillImplementEvent.new(farmId, vehicle)
    afmDebug(' Info: RefillImplementEvent:new')
    local self = RefillImplementEvent.emptyNew()

    self.farmId = farmId
    self.vehicle = vehicle

    return self
end

function RefillImplementEvent:readStream(streamId, connection)
    afmDebug(' Info: RefillImplementEvent:readStream')

    self.farmId = streamReadUIntN(streamId, FarmManager.FARM_ID_SEND_NUM_BITS)
    self.vehicle = NetworkUtil.readNodeObject(streamId)

    self:run(connection)
end

function RefillImplementEvent:writeStream(streamId, connection)
    afmDebug(' Info: RefillImplementEvent:writeStream')

    streamWriteUIntN(streamId, self.farmId, FarmManager.FARM_ID_SEND_NUM_BITS)
    NetworkUtil.writeNodeObject(streamId, self.vehicle)
end

function RefillImplementEvent:run(connection)
    afmDebug(' Info: RefillImplementEvent:run') 

    if not connection:getIsServer() then
        afmDebug(' Info: RefillImplementEvent:run:notServer')
        g_server:broadcastEvent(RefillImplementEvent.new(self.farmId, self.vehicle))
    end

    self:refillImplement(self.farmId, self.vehicle)
end

function RefillImplementEvent.sendEvent(farmId, vehicle)
    afmDebug(' Info: RefillImplementEvent:sendEvent')
    if g_currentMission.missionDynamicInfo.isMultiplayer then 
        if g_server ~= nil then
            g_server:broadcastEvent(RefillImplementEvent.new(farmId, vehicle))
        else
            g_client:getServerConnection():sendEvent(RefillImplementEvent.new(farmId, vehicle))
        end
    else
        RefillImplementEvent:refillImplement(farmId, vehicle)
    end
end

-- Allowed fill types per vehicle specialization
RefillImplementEvent.BALER_TYPES = {
    ROPE = true, NETWRAP = true,
    ROUNDBALENET = true, SQUAREBALENET = true,
    ROUNDBALE_NET = true, SQUAREBALE_NET = true,
}
RefillImplementEvent.SEEDER_TYPES = {
    SEEDS = true,
}

function RefillImplementEvent:refillImplement(farmId, vehicle)
    afmDebug(' Info: RefillImplementEvent:refillImplement')

    if vehicle.getFillUnits == nil then
        return
    end

    local fillUnits = vehicle:getFillUnits()
    if fillUnits == nil then
        return
    end

    -- Only balers and seeders/planters can be refilled
    local allowed = nil
    if vehicle.spec_baler ~= nil then
        allowed = RefillImplementEvent.BALER_TYPES
    elseif vehicle.spec_sowingMachine ~= nil then
        allowed = RefillImplementEvent.SEEDER_TYPES
    end
    if allowed == nil then
        return
    end

    for fillUnitIndex, fillUnit in pairs(fillUnits) do
        local capacity = vehicle:getFillUnitCapacity(fillUnitIndex)
        local currentLevel = vehicle:getFillUnitFillLevel(fillUnitIndex)
        local toFill = capacity - currentLevel

        if toFill > 0 and capacity > 0 then
            local fillTypeToUse = nil
            local currentName = g_fillTypeManager:getFillTypeNameByIndex(fillUnit.fillType)

            -- If already has a valid fill type in our whitelist, use it
            if currentName ~= "UNKNOWN" and allowed[currentName] then
                fillTypeToUse = fillUnit.fillType
            else
                -- Empty unit - find first supported fill type in whitelist
                if fillUnit.supportedFillTypes ~= nil then
                    for ftIndex, _ in pairs(fillUnit.supportedFillTypes) do
                        local ftName = g_fillTypeManager:getFillTypeNameByIndex(ftIndex)
                        if ftName ~= "UNKNOWN" and allowed[ftName] then
                            fillTypeToUse = ftIndex
                            break
                        end
                    end
                end
            end

            if fillTypeToUse ~= nil then
                vehicle:addFillUnitFillLevel(
                    farmId,
                    fillUnitIndex,
                    toFill,
                    fillTypeToUse,
                    ToolType.UNDEFINED,
                    nil
                )
            end
        end
    end

    -- Reload the table for the player
    if g_gui.currentGui ~= nil and g_gui.currentGui.target ~= nil then 
        if g_gui.currentGui.target.pageAFMVehicles ~= nil then
            g_gui.currentGui.target.pageAFMVehicles:rebuildTable()
        end
        if g_gui.currentGui.target.pageAFMImplements ~= nil then
            g_gui.currentGui.target.pageAFMImplements:rebuildTable()
        end
    end
end
