rcDebug("onSave Class")

onSave = {}
local onSave_mt = Class(onSave, Event)

InitEventClass(onSave, "onSave", EventIds.EVENT_SAVE)

function onSave.emptyNew()
  --print("CN-EmptyNew")
  local self = setmetatable({}, onSave_mt)

	return self
end

function onSave.new(mission, i18n, modDirectory, modName)
    --print("CN-New")
	local self = onSave.emptyNew()
  self.mission          = mission
  self.i18n             = i18n
  self.modDirectory     = modDirectory
  self.modName          = modName

	return self
end

-- Send message letting players know that the game is saving
function onSave.saveSavegame()
  if g_server ~= nil and g_dedicatedServer ~= nil then
    Logging.info("Game Save Start")

    -- Send chat message letting everyone know we are saving the game.
    g_server:broadcastEvent(ChatEvent.new(g_i18n:getText("chat_game_saved"),g_currentMission.missionDynamicInfo.serverName,FarmManager.SPECTATOR_FARM_ID,0))
  end
end

-- Called when the game is saved on a server
function onSave.onSaveComplete()
  if g_server ~= nil and g_dedicatedServer ~= nil then
    rcDebug(" Info: Game Save Complete - Update and copy FSG Companion stats and data for bot.")

    local saveFuncs = {
      { "onSaveComplete",      function() g_fsgSettings.onSaveComplete() end },
      { "vehicleStats",        function() onSave.vehicleStats() end },
      { "placeableSiloStats",  function() onSave.getPlaceableSiloStats() end },
      { "placeableStats",      function() onSave.getPlaceableStats() end },
      { "productionStats",     function() onSave.getProductionStats() end },
      { "animalStats",         function() onSave.getAnimalStats() end },
      { "fieldStats",          function() onSave.getFieldStats() end },
      { "playerStats",         function() onSave.getPlayerStats() end },
      { "farmPlayers",         function() onSave.getFarmPlayers() end },
      { "weatherForecast",     function() onSave.getWeatherForecast() end },
      { "copyTransactions",    function() onSave.copyTransactions() end },
      { "copyInboxLog",        function() onSave.copyInboxLog() end },
      { "sellingPrices",       function() onSave.getSellingPrices() end },
      { "runtimeStats",        function()
          if g_runtimeStats ~= nil and g_runtimeStats.saveToSavegame ~= nil then
            g_runtimeStats:saveToSavegame()
          end
        end },
      { "copySaveFiles",       function() onSave.copySaveFiles() end },
    }

    for _, entry in ipairs(saveFuncs) do
      local ok, err = pcall(entry[2])
      if not ok then
        rcErrorLog("onSave." .. entry[1], tostring(err))
      end
    end

    Logging.info("Game Save Complete")

  end
end

-- Create a custom vehicle stats xml for the savegame that contains more details than the original one
function onSave.vehicleStats()
  rcDebug("Building Vehicle Stats for FSG Realism Website to savegame.")
  -- Get all active vehicles data
  local allVehicles = {}
  local newxmlFile
  -- Loop through all the vehicles and send their data to a table if they are not farm 0
  if g_currentMission.vehicleSystem.vehicles ~= nil then
    for _, vehicle in ipairs(g_currentMission.vehicleSystem.vehicles) do
      --rcDebug(vehicle)

      local isSelling        = (vehicle.isDeleted ~= nil and vehicle.isDeleted) or (vehicle.isDeleting ~= nil and vehicle.isDeleting)
      --local hasConned        = vehicle.getIsControlled ~= nil
      local isProperty       = vehicle.propertyState == VehiclePropertyState.OWNED or vehicle.propertyState == VehiclePropertyState.LEASED or vehicle.propertyState == VehiclePropertyState.MISSION
      local isPallet         = vehicle.typeName == "pallet" or vehicle.typeName == "bigBag" or vehicle.typeName == "treeSaplingPallet"
      local isTrain          = vehicle.typeName == "locomotive"
      local isBelt           = vehicle.typeName == "conveyorBelt" or vehicle.typeName == "pickupConveyorBelt"
      local isRidable        = SpecializationUtil.hasSpecialization(Rideable, vehicle.specializations)
      --local isSteerImplement = vehicle.spec_attachable ~= nil

      local skipable         = isTrain or isRidable or isPallet or isBelt

      if not isSelling and not skipable and vehicle.getSellPrice ~= nil and vehicle.price ~= nil and isProperty then
        -- Get vehicle details and if they don't show anything, then zero them out
        local vehicle_getDamageAmount = "0"
        if vehicle.getDamageAmount ~= nil then vehicle_getDamageAmount = vehicle:getDamageAmount() end 
        local vehicle_getWearTotalAmount = "0"
        if vehicle.getWearTotalAmount ~= nil then vehicle_getWearTotalAmount = vehicle:getWearTotalAmount() end 
        local vehicle_getDirtAmount = "0"
        if vehicle.getDirtAmount ~= nil then vehicle_getDirtAmount = vehicle:getDirtAmount() end 
        local vehicle_getSellPrice = "0"
        if vehicle.getSellPrice ~= nil then vehicle_getSellPrice = vehicle:getSellPrice() end 
        local vehicle_getSpeedLimit = "0"
        if vehicle.getSpeedLimit ~= nil then vehicle_getSpeedLimit = vehicle:getSpeedLimit() end 
        -- Put vehicle data together for xml output
        -- rcDebug(vehicle.typeName)
        local vehName          = vehicle:getFullName()
        local vehFarmId        = vehicle.ownerFarmId
        local vehPropertyState = vehicle.propertyState
        local vehFuelLevel     = onSave:getFuel(vehicle)
        local vehDefLevel      = onSave:rawToPerc(onSave:getDEF(vehicle),false)
        local vehDamage        = onSave:rawToPerc(vehicle_getDamageAmount,false)
        local vehWear          = onSave:rawToPerc(vehicle_getWearTotalAmount,true)
        local vehDirt          = onSave:rawToPerc(vehicle_getDirtAmount,false)
        local vehPrice         = vehicle.price
        local vehSellPrice     = math.floor(vehicle_getSellPrice)
        local vehAge           = vehicle.age
        local vehHours         = vehicle.operatingTime / 1000 / 60 / 60
        local vehSpeedLimit    = vehicle_getSpeedLimit
        local vehFillUnits     = nil
        if vehicle.getFillUnits ~= nil then
          vehFillUnits     = onSave:getFills(vehicle:getFillUnits())
        end
        local vehImageFilename = vehicle:getImageFilename()
        local x, y, z          = getWorldTranslation(vehicle.rootNode)
        local vehType          = vehicle.typeName

        local vehicleData = {
          name            = tostring(vehName),
          farmId          = tostring(vehFarmId),
          damage          = tostring(vehDamage),
          propertyState   = tostring(vehPropertyState),
          fuelType        = tostring(vehFuelLevel[1]),
          fuelLevel       = tostring(onSave:rawToPerc(vehFuelLevel[2],false)),
          defLevel        = tostring(vehDefLevel),
          paint           = tostring(vehWear),
          dirt            = tostring(vehDirt),
          price           = tostring(vehPrice),
          sellPrice       = tostring(vehSellPrice),
          age             = tostring(vehAge),
          hours           = tostring(vehHours),
          speedLimit      = tostring(vehSpeedLimit),
          imageFilename   = tostring(vehImageFilename),
          position        = tostring(x .. " " .. y .. " " .. z),
          fillUnits       = vehFillUnits,
          vehType         = vehType
        }

        table.insert(allVehicles, vehicleData)

      elseif vehicle.typeName == "conveyorBelt" or vehicle.typeName == "pickupConveyorBelt" then

        local vehName          = vehicle:getFullName()
        local vehFarmId        = vehicle.ownerFarmId
        local vehPropertyState = vehicle.propertyState
        local vehDamage        = onSave:rawToPerc(vehicle:getDamageAmount(),false)
        local vehType          = vehicle.typeName
        local vehAge           = vehicle.age
        local vehHours         = vehicle.operatingTime / 1000 / 60 / 60
        local x, y, z          = getWorldTranslation(vehicle.rootNode)

        local vehicleData = {
          name            = vehName,
          farmId          = vehFarmId,
          damage          = vehDamage,
          propertyState   = vehPropertyState,
          vehType         = vehType,
          age             = vehAge,
          hours           = vehHours,
          position        = tostring(x .. " " .. y .. " " .. z)
        }

        table.insert(allVehicles, vehicleData)

      elseif vehicle.typeName == "pallet" or vehicle.typeName == "bigBag" or vehicle.typeName == "treeSaplingPallet" then 

        -- local pallet      = vehicle
        -- local mass        = pallet:getTotalMass() * 1000
        -- local farmId      = pallet.ownerFarmId
        -- local palletSpec  = pallet.spec_pallet
        -- local contents    = palletSpec.contents
        -- local fillLevel   = pallet:getFillUnitFillLevel(palletSpec.fillUnitIndex)

        -- rcDebug(pallet)
        -- rcDebug(palletSpec)

        -- local vehicleData = {
        --   mass         = mass,
        --   farmId       = farmId,
        --   fillLevel    = fillLevel,
        -- }

        -- rcDebug(vehicleData)

      end
    end
  end
  -- Make sure there are vehicles to save to the xml data.
  if allVehicles ~= nil then
    --rcDebug(allVehicles)

    --Savegame path and filename
    local savegameFolderPath = getUserProfileAppPath() .. "savegame" .. g_currentMission.missionInfo.savegameIndex
    local savegameFile       = savegameFolderPath .. "/vehicleStats.xml"

    --File Key for xml output
    local key = "vehicleStats"

    --save data to xml file
    newxmlFile = XMLFile.create(key, savegameFile, key)

    local index = 0

    for _, veh in pairs(allVehicles) do
      local subKey = string.format(".vehicle(%d)", index)

      if veh.name ~= nil then newxmlFile:setString(key .. subKey .. "#name", tostring(veh.name)) end
      if veh.farmId ~= nil then newxmlFile:setString(key .. subKey .. "#farmId", tostring(veh.farmId)) end
      if veh.damage ~= nil then newxmlFile:setString(key .. subKey .. "#damage", tostring(veh.damage)) end
      if veh.propertyState ~= nil then newxmlFile:setString(key .. subKey .. "#propertyState", tostring(veh.propertyState)) end
      if veh.fuelType ~= nil then newxmlFile:setString(key .. subKey .. "#fuelType", tostring(veh.fuelType)) end
      if veh.fuelLevel ~= nil then newxmlFile:setString(key .. subKey .. "#fuelLevel", tostring(veh.fuelLevel)) end
      if veh.defLevel ~= nil then newxmlFile:setString(key .. subKey .. "#defLevel", tostring(veh.defLevel)) end
      if veh.paint ~= nil then newxmlFile:setString(key .. subKey .. "#paint", tostring(veh.paint)) end
      if veh.dirt ~= nil then newxmlFile:setString(key .. subKey .. "#dirt", tostring(veh.dirt)) end
      if veh.price ~= nil then newxmlFile:setString(key .. subKey .. "#price", tostring(veh.price)) end
      if veh.sellPrice ~= nil then newxmlFile:setString(key .. subKey .. "#sellPrice", tostring(veh.sellPrice)) end
      if veh.imageFilename ~= nil then newxmlFile:setString(key .. subKey .. "#imageFilename", tostring(veh.imageFilename)) end
      if veh.vehType ~= nil then newxmlFile:setString(key .. subKey .. "#vehType", tostring(veh.vehType)) end
      if veh.position ~= nil then newxmlFile:setString(key .. subKey .. "#position", tostring(veh.position)) end

      -- Check if vehicle has a fill level
      if veh.fillUnits ~= nil and type(veh.fillUnits) == "table" then

        --rcDebug(veh.fillUnits)

        local index2 = 0

        for _, fill in pairs(veh.fillUnits) do
          local fillKey = string.format(".fill(%d)", index2)

          newxmlFile:setString(key .. subKey .. fillKey .. "#index", tostring(index2))
          newxmlFile:setString(key .. subKey .. fillKey .. "#fillType", tostring(fill.fillType))
          newxmlFile:setString(key .. subKey .. fillKey .. "#fillLevel", tostring(fill.fillLevel))
          newxmlFile:setString(key .. subKey .. fillKey .. "#fillPercentage", tostring(fill.fillPercentage))

          index2 = index2 + 1
          fill = {}
        end
      end

      index = index + 1
      veh = {}
    end

    newxmlFile:save()
    newxmlFile:delete()

  end

end

function onSave:getPlaceableSiloStats()
  rcDebug("Building Placeable Silo Stats for FSG Realism Website to savegame.")
	if g_currentMission ~= nil and g_currentMission.placeableSystem and g_currentMission.placeableSystem.placeables then
    local allPlaceables  = {}
    local allPlaceables2 = {}
		for v=1, #g_currentMission.placeableSystem.placeables do
			local thisPlaceable = g_currentMission.placeableSystem.placeables[v]

      -- Extract data from placeable to save in xml file
      local name            = thisPlaceable:getName()
      local farmId          = thisPlaceable.ownerFarmId
      local x, y, z         = getWorldTranslation(thisPlaceable.rootNode)
      local farmlandId      = thisPlaceable.farmlandId
      local typeName        = thisPlaceable.typeName
      local storeItem       = thisPlaceable.storeItem
      local sellPrice       = thisPlaceable:getSellPrice()

      -- Get the mod store icon
      local imageFilename   = ""
      if imageFilename ~= nil then 
        imageFilename = thisPlaceable:getImageFilename()
      end

      -- Extrat data from store Item
      local dailyUpkeep     = storeItem.dailyUpkeep

      -- Ready stuffs for fills
      local siloFillLevels          = {}
      local objectStorageData       = {}
      local bunkerSiloData          = {}
      local manureHeapLevel         = {}

      -- exclude deco or unowned stuffs
      if farmId ~= 0 and (typeName == "silo" or typeName == "bunkerSilo" or typeName == "objectStorage" or typeName == "manureHeap" or typeName == "siloExtension" or typeName == "FS25_RedBarnPack.siloStorage") then

        -- Get fill data if silo
        if typeName == "silo" then
          local rawFillLevels    = {}
          local cleanFillLevels  = {}
          local totalFill        = 0
          local capacity         = 0
          local thisFillLevels   = thisPlaceable:getFillLevels(farmId)
          local spec             = thisPlaceable.spec_silo

          for _, sourceStorage in pairs(spec.loadingStation.sourceStorages) do
            if spec.loadingStation:hasFarmAccessToStorage(farmId, sourceStorage) then
              capacity = capacity + sourceStorage.capacity
            end
          end

          for fillType, fillLevel in pairs(thisFillLevels) do
            rawFillLevels[fillType] = (rawFillLevels[fillType] or 0) + fillLevel
          end

          for fillType, fillLevel in pairs(rawFillLevels) do

            local curFreeCapacity = 0
            local curFillLevel = 0

            for _, storage in ipairs(spec.storages) do
              curFreeCapacity = storage:getFreeCapacity(fillType)

              if curFreeCapacity > 0 then
                curFillLevel = storage:getFillLevel(fillType)
              end
            end

            if fillLevel > 0 then
              local roundFillLevel = MathUtil.round(fillLevel)
              table.insert(cleanFillLevels, {
                fillType    = g_fillTypeManager:getFillTypeNameByIndex(fillType),
                level       = roundFillLevel,
                fillLevel   = curFillLevel,
                freeCapacity = curFreeCapacity
              })
              totalFill = totalFill + roundFillLevel
            end
          end

          table.insert(siloFillLevels, {
            name       = name,
            percent    = MathUtil.getFlooredPercent(totalFill, capacity),
            totalFill  = totalFill,
            capacity   = capacity,
            fillLevels = cleanFillLevels
          })

        elseif typeName == "siloExtension" then

          local cleanFillLevels  = {}
          local totalFill        = 0
          local specSE           = thisPlaceable.spec_siloExtension
          local seStorage        = specSE.storage
          local capacity         = seStorage.capacity

          for fillType, fillLevel in pairs(seStorage.fillLevels) do
            if fillLevel > 0 then
              local roundFillLevel = MathUtil.round(fillLevel)
              table.insert(cleanFillLevels, {
                fillType    = g_fillTypeManager:getFillTypeNameByIndex(fillType),
                level       = roundFillLevel
              })
              totalFill = totalFill + roundFillLevel
            end
          end

          table.insert(siloFillLevels, {
            name       = name,
            percent    = MathUtil.getFlooredPercent(totalFill, capacity),
            totalFill  = totalFill,
            capacity   = capacity,
            fillLevels = cleanFillLevels
          })

        elseif typeName == "bunkerSilo" then

          local specBS            = thisPlaceable.spec_bunkerSilo.bunkerSilo
          local state             = specBS.state
          local fillLevel         = MathUtil.round(specBS.fillLevel)
          local compactedPercent  = specBS.compactedPercent
          local fermentingPercent = MathUtil.round(specBS.fermentingPercent * 100)
          local inputFillType     = g_fillTypeManager:getFillTypeNameByIndex(specBS.inputFillType)
          local outputFillType    = g_fillTypeManager:getFillTypeNameByIndex(specBS.outputFillType)

          table.insert(bunkerSiloData, {
            state                 = state,
            fillLevel             = fillLevel,
            compactedPercent      = compactedPercent,
            fermentingPercent     = fermentingPercent,
            inputFillType         = inputFillType,
            outputFillType        = outputFillType
          })

        elseif typeName == "objectStorage" then

          local infoTable         = {}
          local spec              = thisPlaceable.spec_objectStorage
          local capacity          = spec.capacity
          local numStoredObjects  = spec.numStoredObjects
          local numObjectInfos    = spec.objectInfos

          for _, objectInfo in pairs(numObjectInfos) do       
            if objectInfo.objects[1] ~= nil then
              local title = objectInfo.objects[1]:getDialogText()

              if string.len(title) > 32 then
                title = string.sub(title, 0, 32) .. "..."
              end

              table.insert(infoTable, {
                item        = title,
                numObjects  = tostring(objectInfo.numObjects)
              })
            end
          end

          table.insert(objectStorageData, {
            capacity          = capacity,
            numStoredObjects  = numStoredObjects,
            infoTable         = infoTable,
          })

        elseif typeName == "FS25_RedBarnPack.siloStorage" then

          local rawFillLevels    = {}
          local cleanFillLevels  = {}
          local totalFill        = 0
          local capacity         = 0
          local thisFillLevels   = thisPlaceable:getFillLevels(farmId)
          local spec             = thisPlaceable.spec_silo

          for _, sourceStorage in pairs(spec.loadingStation.sourceStorages) do
            if spec.loadingStation:hasFarmAccessToStorage(farmId, sourceStorage) then
              capacity = capacity + sourceStorage.capacity
            end
          end

          for fillType, fillLevel in pairs(thisFillLevels) do
            rawFillLevels[fillType] = (rawFillLevels[fillType] or 0) + fillLevel
          end

          for fillType, fillLevel in pairs(rawFillLevels) do
            if fillLevel > 0 then
              local roundFillLevel = MathUtil.round(fillLevel)
              table.insert(cleanFillLevels, {
                fillType    = g_fillTypeManager:getFillTypeNameByIndex(fillType),
                level       = roundFillLevel
              })
              totalFill = totalFill + roundFillLevel
            end
          end

          table.insert(siloFillLevels, {
            name       = name,
            percent    = MathUtil.getFlooredPercent(totalFill, capacity),
            totalFill  = totalFill,
            capacity   = capacity,
            fillLevels = cleanFillLevels
          })

          local infoTable         = {}
          local spec              = thisPlaceable.spec_objectStorage
          local capacity          = spec.capacity
          local numStoredObjects  = spec.numStoredObjects
          local numObjectInfos    = spec.objectInfos

          for _, objectInfo in pairs(numObjectInfos) do       
            if objectInfo.objects[1] ~= nil then
              local title = objectInfo.objects[1]:getDialogText()

              if string.len(title) > 32 then
                title = string.sub(title, 0, 32) .. "..."
              end

              table.insert(infoTable, {
                item        = title,
                numObjects  = tostring(objectInfo.numObjects)
              })
            end
          end

          table.insert(objectStorageData, {
            capacity          = capacity,
            numStoredObjects  = numStoredObjects,
            infoTable         = infoTable,
          })

        elseif typeName == "manureHeap" then
          local specMH            = thisPlaceable.spec_manureHeap.manureHeap
          local capacity          = specMH.capacity
          local fillType          = g_fillTypeManager:getFillTypeNameByIndex(specMH.fillTypeIndex)
          local fillLevel         = math.floor(specMH.fillLevels[specMH.fillTypeIndex])

          table.insert(manureHeapLevel, {
            capacity              = capacity,
            fillType              = fillType,
            fillLevel             = fillLevel
          })
        end

        table.insert(allPlaceables, {
          name                = tostring(name),
          farmId              = tostring(farmId),
          position            = tostring(x .. " " .. y .. " " .. z),
          farmlandId          = tostring(farmlandId),
          typeName            = tostring(typeName),
          imageFilename       = tostring(imageFilename),
          dailyUpkeep         = tostring(dailyUpkeep),
          sellPrice           = tostring(sellPrice),
          siloFillLevels      = siloFillLevels,
          manureHeapLevel     = manureHeapLevel,
          objectStorageData   = objectStorageData,
          bunkerSiloData      = bunkerSiloData,
        })

      elseif farmId ~= 0 and (typeName == "productionPoint") then

        table.insert(allPlaceables2, {
          name                = tostring(name),
          farmId              = tostring(farmId),
          position            = tostring(x .. " " .. y .. " " .. z),
          farmlandId          = tostring(farmlandId),
          typeName            = tostring(typeName),
          imageFilename       = tostring(imageFilename),
          dailyUpkeep         = tostring(dailyUpkeep),
          sellPrice           = tostring(sellPrice),
        })

      end

		end

    -- Make sure there are placeables to save to the xml data.
    if allPlaceables ~= nil then
      -- rcDebug("allPlaceables data")
      -- rcDebug(allPlaceables)

      --Savegame path and filename
      local savegameFolderPath = getUserProfileAppPath() .. "savegame" .. g_currentMission.missionInfo.savegameIndex
      local savegameFile       = savegameFolderPath .. "/placeableSiloStats.xml"

      --File Key for xml output
      local key ="placeableSiloStats"

      --save data to xml file
      local newxmlFile = XMLFile.create(key, savegameFile, key)

      local index = 0

      for _, p in pairs(allPlaceables) do
        --rcDebug(p)
        local subKey = string.format(".placeable(%d)", index)

        newxmlFile:setString(key .. subKey .. "#name", tostring(p.name))
        newxmlFile:setString(key .. subKey .. "#farmId", tostring(p.farmId))
        newxmlFile:setString(key .. subKey .. "#position", tostring(p.position))
        newxmlFile:setString(key .. subKey .. "#farmlandId", tostring(p.farmlandId))
        newxmlFile:setString(key .. subKey .. "#typeName", tostring(p.typeName))
        newxmlFile:setString(key .. subKey .. "#imageFilename", tostring(p.imageFilename))
        newxmlFile:setString(key .. subKey .. "#dailyUpkeep", tostring(p.dailyUpkeep))
        newxmlFile:setString(key .. subKey .. "#sellPrice", tostring(p.sellPrice))

        -- if silo add fill data if any
        if p.siloFillLevels ~= nil and type(p.siloFillLevels) == "table" then

          local s = 0

          for _, sf in pairs(p.siloFillLevels) do

            local fillKey = string.format(".silo(%d)", s)

            newxmlFile:setString(key .. subKey .. fillKey .. "#index", tostring(s))
            newxmlFile:setString(key .. subKey .. fillKey .. "#name", tostring(sf.name))
            newxmlFile:setString(key .. subKey .. fillKey .. "#percent", tostring(sf.percent))
            newxmlFile:setString(key .. subKey .. fillKey .. "#capacity", tostring(sf.capacity))
            newxmlFile:setString(key .. subKey .. fillKey .. "#totalFill", tostring(sf.totalFill))

            if sf.fillLevels ~= nil and type(sf.fillLevels) == "table" then

              local f = 0

              for _, fl in pairs(sf.fillLevels) do

                local fillLevelKey = string.format(".fillLevels(%d)", f)

                newxmlFile:setString(key .. subKey .. fillKey .. fillLevelKey .. "#index", tostring(f))
                newxmlFile:setString(key .. subKey .. fillKey .. fillLevelKey .. "#fillType", tostring(fl.fillType))
                newxmlFile:setString(key .. subKey .. fillKey .. fillLevelKey .. "#level", tostring(fl.level))

                f = f + 1
                fl = {}
              end
            end

            s = s + 1
            sf = {}
          end
        end

        -- get bunker silo data 
        if p.bunkerSiloData ~= nil and type(p.bunkerSiloData) == "table" then

          local b = 0

          for _, bsd in pairs(p.bunkerSiloData) do

            local bunkerKey = string.format(".bunkerSilo(%d)", b)

            newxmlFile:setString(key .. subKey .. bunkerKey .. "#index", tostring(b))
            newxmlFile:setString(key .. subKey .. bunkerKey .. "#state", tostring(bsd.state))
            newxmlFile:setString(key .. subKey .. bunkerKey .. "#fillLevel", tostring(bsd.fillLevel))
            newxmlFile:setString(key .. subKey .. bunkerKey .. "#compactedPercent", tostring(bsd.compactedPercent))
            newxmlFile:setString(key .. subKey .. bunkerKey .. "#fermentingPercent", tostring(bsd.fermentingPercent))
            newxmlFile:setString(key .. subKey .. bunkerKey .. "#inputFillType", tostring(bsd.inputFillType))
            newxmlFile:setString(key .. subKey .. bunkerKey .. "#outputFillType", tostring(bsd.outputFillType))

            b = b + 1
            bsd = {}
          end 
        end

        -- get object storage data 
        if p.objectStorageData ~= nil and type(p.objectStorageData) == "table" then

          local o = 0

          for _, osd in pairs(p.objectStorageData) do

            local objectKey = string.format(".objectStorage(%d)", o)

            newxmlFile:setString(key .. subKey .. objectKey .. "#index", tostring(o))
            newxmlFile:setString(key .. subKey .. objectKey .. "#capacity", tostring(osd.capacity))
            newxmlFile:setString(key .. subKey .. objectKey .. "#numStoredObjects", tostring(osd.numStoredObjects))


            if osd.infoTable ~= nil and type(osd.infoTable) == "table" then

              local t = 0

              for _, it in pairs(osd.infoTable) do

                local infoTableKey = string.format(".object(%d)", t)

                newxmlFile:setString(key .. subKey .. objectKey .. infoTableKey .. "#index", tostring(t))
                newxmlFile:setString(key .. subKey .. objectKey .. infoTableKey .. "#item", tostring(it.item))
                newxmlFile:setString(key .. subKey .. objectKey .. infoTableKey .. "#numObjects", tostring(it.numObjects))

                t = t + 1
                it = {}
              end
            end

            o = o + 1
            osd = {}
          end 
        end

        -- get bunker silo data 
        if p.manureHeapLevel ~= nil and type(p.manureHeapLevel) == "table" then

          local m = 0

          for _, mh in pairs(p.manureHeapLevel) do

            local mKey = string.format(".manureHeap(%d)", m)

            newxmlFile:setString(key .. subKey .. mKey .. "#index", tostring(m))
            newxmlFile:setString(key .. subKey .. mKey .. "#capacity", tostring(mh.capacity))
            newxmlFile:setString(key .. subKey .. mKey .. "#fillType", tostring(mh.fillType))
            newxmlFile:setString(key .. subKey .. mKey .. "#fillLevel", tostring(mh.fillLevel))

            m = m + 1
            mh = {}
          end 
        end

        index = index + 1
        p = {}
      end

      newxmlFile:save()
      newxmlFile:delete()

    end

  end
end

function onSave:getPlaceableStats()
  rcDebug("Building Placeable Stats for FSG Realism Website to savegame.")
	if g_currentMission ~= nil and g_currentMission.placeableSystem and g_currentMission.placeableSystem.placeables then
    local allPlaceables  = {}
    local allPlaceables2 = {}
		for v=1, #g_currentMission.placeableSystem.placeables do
			local thisPlaceable = g_currentMission.placeableSystem.placeables[v]

      -- Extract data from placeable to save in xml file
      local name            = thisPlaceable:getName()
      local farmId          = thisPlaceable.ownerFarmId
      local x, y, z         = getWorldTranslation(thisPlaceable.rootNode)
      local farmlandId      = thisPlaceable.farmlandId
      local typeName        = thisPlaceable.typeName
      local storeItem       = thisPlaceable.storeItem
      local sellPrice       = thisPlaceable:getSellPrice()

      -- Get the mod store icon
      local imageFilename   = ""
      if imageFilename ~= nil then 
        imageFilename = thisPlaceable:getImageFilename()
      end

      -- Extrat data from store Item
      local dailyUpkeep     = storeItem.dailyUpkeep

      -- exclude deco or unowned stuffs
      if farmId ~= 0 and (typeName ~= "silo" and typeName ~= "bunkerSilo" and typeName ~= "objectStandage" and typeName ~= "manureHeap" and typeName ~= "siloExtension" and typeName ~= "FS25_RedBarnPack.siloStorage" and typeName ~= "productionPoint") then

        table.insert(allPlaceables, {
          name                = tostring(name),
          farmId              = tostring(farmId),
          position            = tostring(x .. " " .. y .. " " .. z),
          farmlandId          = tostring(farmlandId),
          typeName            = tostring(typeName),
          imageFilename       = tostring(imageFilename),
          dailyUpkeep         = tostring(dailyUpkeep),
          sellPrice           = tostring(sellPrice)
        })

      end

		end

    -- Make sure there are placeables to save to the xml data.
    if allPlaceables ~= nil then
      -- rcDebug("allPlaceables data")
      -- rcDebug(allPlaceables)

      --Savegame path and filename
      local savegameFolderPath = getUserProfileAppPath() .. "savegame" .. g_currentMission.missionInfo.savegameIndex
      local savegameFile       = savegameFolderPath .. "/placeableStats.xml"

      --File Key for xml output
      local key ="placeableStats"

      --save data to xml file
      local newxmlFile = XMLFile.create(key, savegameFile, key)

      local index = 0

      for _, p in pairs(allPlaceables) do
        --rcDebug(p)
        local subKey = string.format(".placeable(%d)", index)

        newxmlFile:setString(key .. subKey .. "#name", tostring(p.name))
        newxmlFile:setString(key .. subKey .. "#farmId", tostring(p.farmId))
        newxmlFile:setString(key .. subKey .. "#position", tostring(p.position))
        newxmlFile:setString(key .. subKey .. "#farmlandId", tostring(p.farmlandId))
        newxmlFile:setString(key .. subKey .. "#typeName", tostring(p.typeName))
        newxmlFile:setString(key .. subKey .. "#imageFilename", tostring(p.imageFilename))
        newxmlFile:setString(key .. subKey .. "#dailyUpkeep", tostring(p.dailyUpkeep))
        newxmlFile:setString(key .. subKey .. "#sellPrice", tostring(p.sellPrice))

        index = index + 1
        p = {}
      end

      newxmlFile:save()
      newxmlFile:delete()

    end
  end
end

function onSave:getProductionStats()
  rcDebug("Building Production Stats for FSG Realism Website to savegame.")
  if g_currentMission ~= nil and g_currentMission.productionChainManager ~= nil then
    local thesePoints = g_currentMission.productionChainManager.productionPoints
    local productionsOuput = {}
    for _, thisProd in ipairs(thesePoints) do
      
      local farmId          = thisProd:getOwnerFarmId()
      local isOwned         = thisProd.isOwned
      local name            = thisProd:getName()
      -- local x, y, z         = getWorldTranslation(thisProd.rootNode)
      local storeItem       = thisProd.owningPlaceable.storeItem
      local sellPrice       = thisProd.owningPlaceable:getSellPrice()

      -- Extrat data from store Item
      local dailyUpkeep     = storeItem.dailyUpkeep

      -- Make sure production is owned and had a farm ID not 0
      if isOwned == true and farmId > 0 then
        local weAreWorkingHere = false
        local inputTable  = {}
        local outputTable = {}
        local procTable   = {}
        for x = 1, #thisProd.inputFillTypeIdsArray do
          local fillType  = thisProd.inputFillTypeIdsArray[x]
          local fillLevel = MathUtil.round(thisProd.storage:getFillLevel(fillType))
          local fillCap   = thisProd.storage:getCapacity(fillType)
          local fillPerc  = MathUtil.getFlooredPercent(fillLevel, fillCap)
          if fillLevel == nil then 
            fillLevel = 0
          end
          if fillType ~= nil then
            table.insert(inputTable, {
              fillType     = g_fillTypeManager:getFillTypeNameByIndex(fillType),
              level        = fillLevel,
              capacity     = fillCap,
              wholePercent = fillPerc
            })
          end
        end
        for x = 1, #thisProd.outputFillTypeIdsArray do
          local fillType  = thisProd.outputFillTypeIdsArray[x]
          local fillLevel = MathUtil.round(thisProd.storage:getFillLevel(fillType))
          local fillCap   = thisProd.storage:getCapacity(fillType)
          local fillPerc  = MathUtil.getFlooredPercent(fillLevel, fillCap)
          local fillDest  = thisProd:getOutputDistributionMode(fillType)
          if fillLevel == nil then 
            fillLevel = 0
          end
          if fillDest == 0 then 
            fillDest = "Spawning"
          elseif fillDest == 1 then 
            fillDest = "Selling"
          elseif fillDest == 2 then
            fillDest = "Distributing"
          else 
            fillDest = "Storing"
          end
          if fillType ~= nil then
            table.insert(outputTable, {
              fillType     = g_fillTypeManager:getFillTypeNameByIndex(fillType),
              level        = fillLevel,
              capacity     = fillCap,
              wholePercent = fillPerc,
              destination  = fillDest
            })
          end
        end
        if thisProd.productions ~= nil then
          for _, thisProcess in ipairs(thisProd.productions) do
            local prRunning   = thisProd:getIsProductionEnabled(thisProcess.id)
            local prStatus    = thisProd:getProductionStatus(thisProcess.id)
            local prStatusTxt = Utils.getNoNil(g_i18n:getText(ProductionPoint.PROD_STATUS_TO_L10N[prStatus]), "unknown")
            if not weAreWorkingHere and prRunning then
              -- Something in this production point is running
              weAreWorkingHere = true
            end

            -- get the recipe inputs for this process
            local piTable = {}
            if thisProcess.inputs ~= nil then
              for _, pi in ipairs(thisProcess.inputs) do 
                table.insert(piTable, {
                  type    = g_fillTypeManager:getFillTypeNameByIndex(pi.type),
                  amount  = pi.amount 
                })
              end
            end

            -- get the recipe inputs for this process
            local poTable = {}
            if thisProcess.outputs ~= nil then
              for _, po in ipairs(thisProcess.outputs) do 
                table.insert(poTable, {
                  type    = g_fillTypeManager:getFillTypeNameByIndex(po.type),
                  amount  = po.amount 
                })
              end
            end

            -- put the process table together
            table.insert(procTable, {
              name                  = thisProcess.name,
              isRunning             = prRunning,
              statusText            = prStatusTxt,
              costsPerActiveMonth   = thisProcess.costsPerActiveMonth,
              costsPerActiveHour    = thisProcess.costsPerActiveHour,
              costsPerActiveMinute  = thisProcess.costsPerActiveMinute,
              cyclesPerMonth        = thisProcess.cyclesPerMonth,
              cyclesPerHour         = thisProcess.cyclesPerHour,
              cyclesPerMinute       = thisProcess.cyclesPerMinute,
              recipeInputs          = piTable,
              recipeOutputs         = poTable
            })
          end
        end
        table.insert(productionsOuput, {
          name          = name,
          farmId        = farmId,
          prodActive    = weAreWorkingHere,
          prodStatus    = weAreWorkingHere and g_i18n:getText("ui_production_status_running") or g_i18n:getText("ui_production_status_inactive"),
          inputTable    = inputTable,
          outputTable   = outputTable,
          procTable     = procTable,
          -- position      = x .. " " .. y .. " " .. z,
          dailyUpkeep   = tostring(dailyUpkeep),
          sellPrice   = tostring(sellPrice),
        })
      end
    end
    -- Send productions data to xml if any exist
    if productionsOuput ~= nil then
      --rcDebug(productionsOuput)

      --Savegame path and filename
      local savegameFolderPath = getUserProfileAppPath() .. "savegame" .. g_currentMission.missionInfo.savegameIndex
      local savegameFile       = savegameFolderPath .. "/productionStats.xml"

      --File Key for xml output
      local key = "productionStats"

      --save data to xml file
      local newxmlFile = XMLFile.create(key, savegameFile, key)

      local index = 0

      for _, pro in pairs(productionsOuput) do
        local subKey = string.format(".production(%d)", index)

        newxmlFile:setString(key .. subKey .. "#name", tostring(pro.name))
        newxmlFile:setString(key .. subKey .. "#farmId", tostring(pro.farmId))
        newxmlFile:setString(key .. subKey .. "#prodActive", tostring(pro.prodActive))
        newxmlFile:setString(key .. subKey .. "#prodStatus", tostring(pro.prodStatus))
        -- newxmlFile:setString(key .. subKey .. "#position", tostring(pro.position))
        newxmlFile:setString(key .. subKey .. "#dailyUpkeep", tostring(pro.dailyUpkeep))
        newxmlFile:setString(key .. subKey .. "#sellPrice", tostring(pro.sellPrice))

        -- Check if production has a inputs
        if pro.inputTable ~= nil and type(pro.inputTable) == "table" then

          local i = 0

          for _, input in pairs(pro.inputTable) do
            local inputKey = string.format(".inputs(%d)", i)

            newxmlFile:setString(key .. subKey .. inputKey .. "#index", tostring(i))
            newxmlFile:setString(key .. subKey .. inputKey .. "#fillType", tostring(input.fillType))
            newxmlFile:setString(key .. subKey .. inputKey .. "#level", tostring(input.level))
            newxmlFile:setString(key .. subKey .. inputKey .. "#capacity", tostring(input.capacity))
            newxmlFile:setString(key .. subKey .. inputKey .. "#wholePercent", tostring(input.wholePercent))

            i = i + 1
            input = {}
          end
        end

        -- Check if production has a inputs
        if pro.outputTable ~= nil and type(pro.outputTable) == "table" then
            
          local o = 0

          for _, output in pairs(pro.outputTable) do
            local outputKey = string.format(".outputs(%d)", o)

            newxmlFile:setString(key .. subKey .. outputKey .. "#index", tostring(o))
            newxmlFile:setString(key .. subKey .. outputKey .. "#fillType", tostring(output.fillType))
            newxmlFile:setString(key .. subKey .. outputKey .. "#level", tostring(output.level))
            newxmlFile:setString(key .. subKey .. outputKey .. "#capacity", tostring(output.capacity))
            newxmlFile:setString(key .. subKey .. outputKey .. "#wholePercent", tostring(output.wholePercent))
            newxmlFile:setString(key .. subKey .. outputKey .. "#destination", tostring(output.destination))

            o = o + 1
            output = {}
          end
        end

        -- Check if production has a products
        if pro.procTable ~= nil and type(pro.procTable) == "table" then
            
          local p = 0

          for _, product in pairs(pro.procTable) do
            local productKey = string.format(".products(%d)", p)

            newxmlFile:setString(key .. subKey .. productKey .. "#index", tostring(p))
            newxmlFile:setString(key .. subKey .. productKey .. "#name", tostring(product.name))
            newxmlFile:setString(key .. subKey .. productKey .. "#isRunning", tostring(product.isRunning))
            newxmlFile:setString(key .. subKey .. productKey .. "#statusText", tostring(product.statusText))
            newxmlFile:setString(key .. subKey .. productKey .. "#costsPerActiveMonth", tostring(product.costsPerActiveMonth))
            newxmlFile:setString(key .. subKey .. productKey .. "#costsPerActiveHour", tostring(product.costsPerActiveHour))
            newxmlFile:setString(key .. subKey .. productKey .. "#costsPerActiveMinute", tostring(product.costsPerActiveMinute))
            newxmlFile:setString(key .. subKey .. productKey .. "#cyclesPerMonth", tostring(product.cyclesPerMonth))
            newxmlFile:setString(key .. subKey .. productKey .. "#cyclesPerHour", tostring(product.cyclesPerHour))
            newxmlFile:setString(key .. subKey .. productKey .. "#cyclesPerMinute", tostring(product.cyclesPerMinute))

            -- Check if production has a product inputs
            if product.recipeInputs ~= nil and type(product.recipeInputs) == "table" then
                
              local pi = 0

              for _, pInput in pairs(product.recipeInputs) do
                local pInputKey = string.format(".recipeInputs(%d)", pi)

                newxmlFile:setString(key .. subKey .. productKey .. pInputKey .. "#index", tostring(pi))
                newxmlFile:setString(key .. subKey .. productKey .. pInputKey .. "#type", tostring(pInput.type))
                newxmlFile:setString(key .. subKey .. productKey .. pInputKey .. "#amount", tostring(pInput.amount))

                pi = pi + 1
                pInput = {}
              end
            end

            -- Check if production has a product outputs
            if product.recipeOutputs ~= nil and type(product.recipeOutputs) == "table" then
                
              local po = 0

              for _, pOutput in pairs(product.recipeOutputs) do
                local pOutputKey = string.format(".recipeOutputs(%d)", po)

                newxmlFile:setString(key .. subKey .. productKey .. pOutputKey .. "#index", tostring(po))
                newxmlFile:setString(key .. subKey .. productKey .. pOutputKey .. "#type", tostring(pOutput.type))
                newxmlFile:setString(key .. subKey .. productKey .. pOutputKey .. "#amount", tostring(pOutput.amount))

                po = po + 1
                pOutput = {}
              end
            end

            p = p + 1
            product = {}
          end
        end

        index = index + 1
        pro = {}
      end

      newxmlFile:save()
      newxmlFile:delete()

    end
  end
end

function onSave:getAnimalStats()
  rcDebug("Animal Husbandry Stats for FSG Realism Website to savegame.")
  local allFarms = {}
  if g_farmlandManager.getFarms ~= nil then
    allFarms = g_farmlandManager.getFarms
  else
    if g_dedicatedServer == nil then
      allFarms.farmId = 1
    end
  end
  if allFarms ~= nil then
    local animalStats = {}
    for _, farm in ipairs(g_farmManager:getFarms()) do
      
      local allHusbandries = g_currentMission.husbandrySystem:getPlaceablesByFarm(farm.farmId)

      for _, husbandry in ipairs(allHusbandries) do

        local thisHusb        = husbandry
        local farmId          = farm.farmId
        local name            = thisHusb:getName()
        local thisNumClusters = thisHusb:getNumOfClusters()
        local animalTypeIndex = thisHusb:getAnimalTypeIndex()
        local clusters        = thisHusb:getClusters()
        -- local x, y, z         = getWorldTranslation(thisHusb.rootNode)
        local dispFood        = {}
        local dispOuts        = {}
        local sellPrice       = thisHusb:getSellPrice()

        --rcDebug(thisHusb)

        if thisHusb.getFoodInfos ~= nil then
          local thisFood = thisHusb:getFoodInfos()
          for _, thisFoodInfo in ipairs(thisFood) do
            table.insert(dispFood, {
              title     = thisFoodInfo.title,
              percent   = math.ceil(thisFoodInfo.ratio * 100),
              capacity  = thisFoodInfo.capacity,
              fillLevel = math.floor(thisFoodInfo.value)
            })
          end
        end

        if thisHusb.getConditionInfos ~= nil then
          local thisCond = thisHusb:getConditionInfos()

          if #thisCond > 1 then
            for v=1, #thisCond do
              local thisCondInfo = thisCond[v]
              table.insert(dispOuts, {
                title     = thisCondInfo.title,
                percent   = math.ceil(thisCondInfo.ratio * 100),
                fillLevel = math.floor(thisCondInfo.value),
                invert    = thisCondInfo.invertedBar
              })
            end
          end
        end

        local animalClusters = {}
        if clusters ~= nil then
          for _, cluster in ipairs(clusters) do
            --rcDebug(cluster)
            local animalType              = g_currentMission.animalSystem:getSubTypeByIndex(cluster.subTypeIndex)
            local age                     = cluster.age
            local health                  = cluster.health
            local reproduction            = cluster.reproduction
            local isDirty                 = cluster.isDirty
            local numAnimals              = cluster.numAnimals
            local repoType                = "Reproduction"
            local puberty                 = nil

            --rcDebug(animalType)
            -- Check if reproduction age is less than current
            if animalType.reproductionMinAgeMonth > age then
              -- animal is in puberty stage
              repoType = "Puberty"
              -- figure out what percentage of puberty they are in
              local pubertyCalc = (age / animalType.reproductionMinAgeMonth) * 100
              puberty = math.floor(pubertyCalc)              
            end

            local sellPrice = 0
            if cluster.getSellPrice ~= nil then
              sellPrice = math.floor(cluster:getSellPrice())
            end 

            if animalTypeIndex == 4 then
              -- Do stuff for horses
              local horseName   = cluster.name
              local fitness     = cluster.fitness
              local riding      = cluster.riding
              
              local cleanliness = 100
              if cluster.dirt ~= nil then
                if cluster.dirt > 0 then 
                  cleanliness = 100 - cluster.dirt
                end
              end

              table.insert(animalClusters,{
                type           = animalType.name,
                name           = horseName,
                age            = age,
                health         = health,
                reproduction   = reproduction,
                isDirty        = isDirty,
                numAnimals     = numAnimals,
                repoType       = repoType,
                puberty        = puberty,
                fitness        = fitness,
                riding         = riding,
                cleanliness    = cleanliness,
                sellPrice      = sellPrice,
              })

            else
              -- Do stuff for everything else
              table.insert(animalClusters,{
                type           = animalType.name,
                age            = age,
                health         = health,
                reproduction   = reproduction,
                isDirty        = isDirty,
                numAnimals     = numAnimals,
                repoType       = repoType,
                puberty        = puberty,
                sellPrice      = sellPrice,
              })
            end
          end
        end

        --rcDebug(animalClusters)

        table.insert(animalStats, {
          farmId          = farmId,
          name            = name,
          -- position        = tostring(x .. " " .. y .. " " .. z),
          sellPrice       = sellPrice,
          thisNumClusters = thisNumClusters,
          animalTypeIndex = animalTypeIndex,
          animalClusters  = animalClusters,
          dispFood        = dispFood,
          dispOuts        = dispOuts,
        })
      end

    end

    -- Make sure there are animals to save to the xml data.
    if animalStats ~= nil then
      --rcDebug(animalStats)

      --Savegame path and filename
      local savegameFolderPath = getUserProfileAppPath() .. "savegame" .. g_currentMission.missionInfo.savegameIndex
      local savegameFile       = savegameFolderPath .. "/animalStats.xml"

      --File Key for xml output
      local key = "animalStats"

      --save data to xml file
      local newxmlFile = XMLFile.create(key, savegameFile, key)

      local i = 0

      for _, as in pairs(animalStats) do
        local subKey = string.format(".husbandry(%d)", i)

        newxmlFile:setString(key .. subKey .. "#name", tostring(as.name))
        newxmlFile:setString(key .. subKey .. "#farmId", tostring(as.farmId))
        -- newxmlFile:setString(key .. subKey .. "#position", tostring(as.position))
        newxmlFile:setString(key .. subKey .. "#sellPrice", tostring(as.sellPrice))
        newxmlFile:setString(key .. subKey .. "#thisNumClusters", tostring(as.thisNumClusters))
        newxmlFile:setString(key .. subKey .. "#animalTypeIndex", tostring(as.animalTypeIndex))

        -- Check if animals have clusters
        if as.animalClusters ~= nil and type(as.animalClusters) == "table" then

          local c = 0

          for _, ac in pairs(as.animalClusters) do
            local clsuterKey = string.format(".cluster(%d)", c)

            newxmlFile:setString(key .. subKey .. clsuterKey .. "#index", tostring(c))
            newxmlFile:setString(key .. subKey .. clsuterKey .. "#type", tostring(ac.type))
            newxmlFile:setString(key .. subKey .. clsuterKey .. "#age", tostring(ac.age))
            newxmlFile:setString(key .. subKey .. clsuterKey .. "#health", tostring(ac.health))
            newxmlFile:setString(key .. subKey .. clsuterKey .. "#reproduction", tostring(ac.reproduction))
            newxmlFile:setString(key .. subKey .. clsuterKey .. "#isDirty", tostring(ac.isDirty))
            newxmlFile:setString(key .. subKey .. clsuterKey .. "#numAnimals", tostring(ac.numAnimals))
            newxmlFile:setString(key .. subKey .. clsuterKey .. "#repoType", tostring(ac.repoType))
            newxmlFile:setString(key .. subKey .. clsuterKey .. "#sellPrice", tostring(ac.sellPrice))
            if ac.puberty ~= nil then
              newxmlFile:setString(key .. subKey .. clsuterKey .. "#puberty", tostring(ac.puberty))
            end
            if ac.name ~= nil then 
              newxmlFile:setString(key .. subKey .. clsuterKey .. "#name", tostring(ac.name))
            end
            if ac.fitness ~= nil then 
              newxmlFile:setString(key .. subKey .. clsuterKey .. "#fitness", tostring(ac.fitness))
            end  
            if ac.riding ~= nil then 
              newxmlFile:setString(key .. subKey .. clsuterKey .. "#riding", tostring(ac.riding))
            end  
            if ac.cleanliness ~= nil then 
              newxmlFile:setString(key .. subKey .. clsuterKey .. "#cleanliness", tostring(ac.cleanliness))
            end  

            c = c + 1
            ac = {}
          end
        end

        -- Check if animals have food
        if as.dispFood ~= nil and type(as.dispFood) == "table" then

          local f = 0

          for _, df in pairs(as.dispFood) do
            local foodKey = string.format(".food(%d)", f)

            newxmlFile:setString(key .. subKey .. foodKey .. "#index", tostring(f))
            newxmlFile:setString(key .. subKey .. foodKey .. "#title", tostring(df.title))
            newxmlFile:setString(key .. subKey .. foodKey .. "#percent", tostring(df.percent))
            newxmlFile:setString(key .. subKey .. foodKey .. "#capacity", tostring(df.capacity))
            newxmlFile:setString(key .. subKey .. foodKey .. "#fillLevel", tostring(df.fillLevel))

            f = f + 1
            df = {}
          end
        end

        -- Check if animals have outputs
        if as.dispOuts ~= nil and type(as.dispOuts) == "table" then

          local o = 0

          for _, out in pairs(as.dispOuts) do
            local outputKey = string.format(".output(%d)", o)

            newxmlFile:setString(key .. subKey .. outputKey .. "#index", tostring(o))
            newxmlFile:setString(key .. subKey .. outputKey .. "#title", tostring(out.title))
            newxmlFile:setString(key .. subKey .. outputKey .. "#percent", tostring(out.percent))
            newxmlFile:setString(key .. subKey .. outputKey .. "#invert", tostring(out.invert))
            newxmlFile:setString(key .. subKey .. outputKey .. "#fillLevel", tostring(out.fillLevel))

            o = o + 1
            out = {}
          end
        end

        i = i + 1
        as = {}
      end

      newxmlFile:save()
      newxmlFile:delete()

    end


  end
end

function onSave:getFuel(vehicle)
    local fuelTypeList = {
        {
            FillType.DIESEL,
            "fillType_diesel",
        }, {
            FillType.ELECTRICCHARGE,
            "fillType_electricCharge",
        }, {
            FillType.METHANE,
            "fillType_methane",
        }
    }
    if vehicle.getConsumerFillUnitIndex ~= nil then
        -- This should always pass, unless it's a very odd custom vehicle type.
        for _, fuelType in pairs(fuelTypeList) do
            local fillUnitIndex = vehicle:getConsumerFillUnitIndex(fuelType[1])
            if ( fillUnitIndex ~= nil ) then
                local fuelLevel  = vehicle:getFillUnitFillLevel(fillUnitIndex)
                local capacity   = vehicle:getFillUnitCapacity(fillUnitIndex)
                local percentage = fuelLevel / capacity
                return { fuelType[2], percentage }
            end
        end
    end
    return { false } -- unknown fuel type, should not be possible.
end

function onSave:getDEF(vehicle)
  if vehicle.getConsumerFillUnitIndex ~= nil then
    local defFillUnitIndex = vehicle:getConsumerFillUnitIndex(FillType.DEF)

    if defFillUnitIndex ~= nil then
        local fillLevel = vehicle:getFillUnitFillLevel(defFillUnitIndex)
        local capacity  = vehicle:getFillUnitCapacity(defFillUnitIndex)
        return fillLevel / capacity
    end
    return nil
  end
  return { false } -- unknown fuel type, should not be possible.
end

function onSave:getFills(fills)
  if fills ~= nil then
    -- loop through the fills to build a table of fill types for output
    fillDataTable = {}
    for _, fill in pairs(fills) do

      --rcDebug(fill)

      -- Get fill percentage
      local fillPercentage = 0
      if fill.fillLevel ~= 0 and fill.capacity ~= 0 then
        fillPercentage = (fill.fillLevel / fill.capacity) * 100
      end
      local fillType = g_fillTypeManager:getFillTypeNameByIndex(fill.fillType)
      local fillLevel = fill.fillLevel

      local isFuelFill = fillType == "DIESEL" or fillType == "ELECTRICCHARGE" or fillType == "METHANE"
      local isNotNeededFill = fillType == "UNKNOWN" or fillType == "AIR"

      if not isFuelFill and not isNotNeededFill then

        fillData = {
          fillPercentage    = tostring(fillPercentage),
          fillType          = tostring(fillType),
          fillLevel         = tostring(fillLevel)
        }

        table.insert(fillDataTable, fillData)

      end

    end
    return fillDataTable
  end
  return { false }
end

function onSave:rawToPerc(value, invert)
  if value ~= nil and type(value) ~= "table" then
    if not invert then
        return math.ceil((value)*100)
    end
    return math.ceil((1 - value)*100)
  else
    return 0
  end
end

-- Get field stats for website. 
function onSave:getFieldStats()
  rcDebug("onSave:GetFieldStats")
  -- Load all the files that are in FieldData and compile to one file for savegame
  local modSettingsFolderPath = getUserProfileAppPath()  .. "modSettings/" .. ((FSGSettings and FSGSettings.modName) or g_currentModName or "FS25_FSG_Companion") .. "/FieldsData"
	local files = Files.new(modSettingsFolderPath)

  local key = "fields"
  local fields = {}

	for _, loadFile in pairs(files.files) do

    if loadFile.filename ~= nil then

      local xmlFile = XMLFile.load(key, modSettingsFolderPath .. "/" .. loadFile.filename)

      -- Get previous farm managers from xml
      xmlFile:iterate(key .. ".field", function (_, fieldKey)
        local field = {
          fieldId = xmlFile:getString(fieldKey .. "#fieldId"),
          ownerFarmId = xmlFile:getString(fieldKey .. "#ownerFarmId"),
          farmlandId = xmlFile:getString(fieldKey .. "#farmlandId"),
          fieldArea = xmlFile:getString(fieldKey .. "#fieldArea"),
          getFieldFruitStatus = xmlFile:getString(fieldKey .. "#getFieldFruitStatus"),
          getFieldStage = xmlFile:getString(fieldKey .. "#getFieldStage"),
          getWheelsInfo = xmlFile:getString(fieldKey .. "#getWheelsInfo"),
          weedInfo = xmlFile:getString(fieldKey .. "#weedInfo"),
          limeInfo = xmlFile:getString(fieldKey .. "#limeInfo"),
          plowingInfo = xmlFile:getString(fieldKey .. "#plowingInfo"),
          rollingInfo = xmlFile:getString(fieldKey .. "#rollingInfo"),
          fertilizationInfo = xmlFile:getString(fieldKey .. "#fertilizationInfo"),
          fieldAreaFull = xmlFile:getString(fieldKey .. "#fieldAreaFull"),
          fieldFruitName = xmlFile:getString(fieldKey .. "#fieldFruitName"),
          posX = xmlFile:getString(fieldKey .. "#posX"),
          posZ = xmlFile:getString(fieldKey .. "#posZ"),
          farmlandPrice = xmlFile:getString(fieldKey .. "#farmlandPrice")
        }
        table.insert(fields, field)
      end)

		end
  end

  --Savegame path and filename
  local savegameFolderPath = getUserProfileAppPath() .. "savegame" .. g_currentMission.missionInfo.savegameIndex
  local savegameFile       = savegameFolderPath .. "/fieldsStats.xml"

  --save data to xml file
  local newxmlFile = XMLFile.create(key, savegameFile, key)

  local index = 0

  for _, saveField in pairs(fields) do
    local subKey = string.format(".field(%d)", index)
    newxmlFile:setString(key .. subKey .. "#fieldId", tostring(saveField.fieldId))
    newxmlFile:setString(key .. subKey .. "#ownerFarmId", tostring(saveField.ownerFarmId))
    newxmlFile:setString(key .. subKey .. "#farmlandId", tostring(saveField.farmlandId))
    newxmlFile:setString(key .. subKey .. "#fieldArea", tostring(saveField.fieldArea))
    newxmlFile:setString(key .. subKey .. "#getFieldFruitStatus", tostring(saveField.getFieldFruitStatus))
    newxmlFile:setString(key .. subKey .. "#getFieldStage", tostring(saveField.getFieldStage))
    newxmlFile:setString(key .. subKey .. "#getWheelsInfo", tostring(saveField.getWheelsInfo))
    newxmlFile:setString(key .. subKey .. "#weedInfo", tostring(saveField.weedInfo))
    newxmlFile:setString(key .. subKey .. "#limeInfo", tostring(saveField.limeInfo))
    newxmlFile:setString(key .. subKey .. "#plowingInfo", tostring(saveField.plowingInfo))
    newxmlFile:setString(key .. subKey .. "#rollingInfo", tostring(saveField.rollingInfo))
    newxmlFile:setString(key .. subKey .. "#fertilizationInfo", tostring(saveField.fertilizationInfo))
    newxmlFile:setString(key .. subKey .. "#fieldAreaFull", tostring(saveField.fieldAreaFull))
    newxmlFile:setString(key .. subKey .. "#fieldFruitName", tostring(saveField.fieldFruitName))
    newxmlFile:setString(key .. subKey .. "#posX", tostring(saveField.posX))
    newxmlFile:setString(key .. subKey .. "#posZ", tostring(saveField.posZ))
    newxmlFile:setString(key .. subKey .. "#farmlandPrice", tostring(saveField.farmlandPrice))
    index = index + 1
  end

  newxmlFile:save()
  newxmlFile:delete()

end

-- Copy weather forecast file over to savegame
function onSave:getWeatherForecast()
  -- Save weather forecast to xml
  local savegameFolderPath = getUserProfileAppPath() .. "savegame" .. g_currentMission.missionInfo.savegameIndex
	local modSettingsFolderPath = getUserProfileAppPath()  .. "modSettings/" .. ((FSGSettings and FSGSettings.modName) or g_currentModName or "FS25_FSG_Companion") .. ""
	local weatherForecastFile = modSettingsFolderPath .. "/WeatherForecast.xml"
	local weatherForecastFileSave = savegameFolderPath .. "/WeatherForecast.xml"

  if ( fileExists(weatherForecastFile) ) then
    copyFile(weatherForecastFile, weatherForecastFileSave, true)
  end
end

-- Build playerStats.xml with currently connected players + farm mapping
function onSave.getPlayerStats()
  if g_currentMission == nil or g_currentMission.userManager == nil then return end

  rcDebug("Building Player Stats for bot.")
  local savegameFolderPath = getUserProfileAppPath() .. "savegame" .. g_currentMission.missionInfo.savegameIndex
  local xmlFile = createXMLFile("playerStats", savegameFolderPath .. "/playerStats.xml", "players")

  local users = g_currentMission.userManager:getUsers() or {}
  local idx = 0

  for _, user in ipairs(users) do
    if user ~= nil and user.nickname ~= "Server" then
      local uniqueId = ""
      if user.getUniqueUserId ~= nil then
        uniqueId = tostring(user:getUniqueUserId())
      end
      local nickname = user.nickname or ""
      local farmId = 0
      local farm = g_farmManager:getFarmByUserId(user.id)
      if farm ~= nil then
        farmId = farm.farmId
      end
      local playtime = 0
      if user.getConnectedTime ~= nil then
        playtime = math.floor((g_currentMission.time - user:getConnectedTime()) / 60000)
      end

      local key = string.format("players.player(%d)", idx)
      setXMLString(xmlFile, key .. "#uniqueUserId", uniqueId)
      setXMLString(xmlFile, key .. "#name", HTMLUtil.encodeToHTML(nickname, true))
      setXMLInt(xmlFile, key .. "#farmId", farmId)
      setXMLInt(xmlFile, key .. "#playTime", playtime)
      setXMLBool(xmlFile, key .. "#isOnline", true)
      idx = idx + 1
    end
  end

  saveXMLFile(xmlFile)
  delete(xmlFile)
end

-- Export farm-to-player mapping with permissions
function onSave.getFarmPlayers()
  if g_currentMission == nil or g_farmManager == nil then return end

  rcDebug("Building Farm Players mapping for bot.")
  local savegameFolderPath = getUserProfileAppPath() .. "savegame" .. g_currentMission.missionInfo.savegameIndex
  local xmlFile = createXMLFile("farmPlayers", savegameFolderPath .. "/farmPlayers.xml", "farmPlayers")

  local farms = g_farmManager:getFarms()
  local farmIdx = 0

  for _, farm in ipairs(farms) do
    if farm ~= nil and farm.farmId ~= FarmManager.SPECTATOR_FARM_ID then
      local farmKey = string.format("farmPlayers.farm(%d)", farmIdx)
      setXMLInt(xmlFile, farmKey .. "#farmId", farm.farmId)
      setXMLString(xmlFile, farmKey .. "#name", HTMLUtil.encodeToHTML(farm.name or "", true))
      setXMLInt(xmlFile, farmKey .. "#balance", math.floor(farm:getBalance()))
      setXMLInt(xmlFile, farmKey .. "#loan", math.floor(farm:getLoan()))
      setXMLInt(xmlFile, farmKey .. "#color", farm.color or 0)

      -- Export players in this farm: both online users AND registered farm members
      local playerIdx = 0
      local exportedUids = {}

      -- First: export online users in this farm
      local users = g_currentMission.userManager:getUsers() or {}
      for _, user in ipairs(users) do
        if user ~= nil and user.nickname ~= "Server" then
          local userFarm = g_farmManager:getFarmByUserId(user:getId())
          if userFarm ~= nil and userFarm.farmId == farm.farmId then
            local playerKey = string.format("%s.player(%d)", farmKey, playerIdx)
            local uniqueId = ""
            if user.getUniqueUserId ~= nil then
              uniqueId = tostring(user:getUniqueUserId())
            end
            setXMLString(xmlFile, playerKey .. "#uniqueUserId", uniqueId)
            setXMLString(xmlFile, playerKey .. "#name", HTMLUtil.encodeToHTML(user.nickname or "", true))
            setXMLBool(xmlFile, playerKey .. "#isOnline", true)

            -- Check farm manager status
            local isFM = false
            if userFarm.users ~= nil then
              for _, farmUser in pairs(userFarm.users) do
                if farmUser.uniqueUserId == uniqueId and (farmUser.permissions ~= nil and farmUser.permissions[Farm.PERMISSION.MANAGE_RIGHTS]) then
                  isFM = true
                  break
                end
              end
            end
            setXMLBool(xmlFile, playerKey .. "#isFarmManager", isFM)

            -- Check admin status
            local isAdmin = (g_currentMission.isMasterUser and user:getId() == g_currentMission.playerUserId) or false
            setXMLBool(xmlFile, playerKey .. "#isAdmin", isAdmin)

            exportedUids[uniqueId] = true
            playerIdx = playerIdx + 1
          end
        end
      end

      -- Second: export registered farm members who are NOT currently online
      if farm.users ~= nil then
        for _, farmUser in pairs(farm.users) do
          local uid = farmUser.uniqueUserId or ""
          if uid ~= "" and not exportedUids[uid] then
            local playerKey = string.format("%s.player(%d)", farmKey, playerIdx)
            setXMLString(xmlFile, playerKey .. "#uniqueUserId", uid)
            -- Try to get last known name from runtime stats
            local knownName = ""
            if g_runtimeStats ~= nil and g_runtimeStats.players ~= nil then
              for _, rp in pairs(g_runtimeStats.players) do
                if tostring(rp.uniqueUserId) == uid and rp.nickname ~= nil then
                  knownName = rp.nickname
                  break
                end
              end
            end
            setXMLString(xmlFile, playerKey .. "#name", HTMLUtil.encodeToHTML(knownName, true))
            setXMLBool(xmlFile, playerKey .. "#isOnline", false)
            local isFM = farmUser.permissions ~= nil and farmUser.permissions[Farm.PERMISSION.MANAGE_RIGHTS] == true
            setXMLBool(xmlFile, playerKey .. "#isFarmManager", isFM)
            setXMLBool(xmlFile, playerKey .. "#isAdmin", false)
            exportedUids[uid] = true
            playerIdx = playerIdx + 1
          end
        end
      end

      farmIdx = farmIdx + 1
    end
  end

  -- Also export current mod settings for the admin panel
  if g_fsgSettings ~= nil and g_fsgSettings.settings ~= nil then
    local settingsKey = "farmPlayers.modSettings"
    local settingsList = {
      "limitsEnabled", "dismissWorkers", "inboxActive", "paintAnywhere",
      "disableSleep", "disableBorrowEquipment", "timeSyncEnable",
      "autoSetTime", "progressNoti", "enablePlayerTracking",
      "trackingIdleKickEnabled", "coopLimitsEnabled",
    }
    for _, sName in ipairs(settingsList) do
      local val = g_fsgSettings.settings:getValue(sName)
      if val ~= nil then
        setXMLBool(xmlFile, settingsKey .. "#" .. sName, val == true)
      end
    end
    local numSettings = {
      "hireLimit", "maxMissions", "husbandryLimit", "productionPoints",
      "sellingPoints", "farmHouses", "generators", "gardenSheds",
      "floodLighting", "placeableGreenhouses", "otherPlaceables",
      "serverOffset", "timeFixHour",
      "trackingIntervalSec", "trackingIdleKickMinutes",
      "coopMinCruiseSpeed", "coopMinCruiseMin",
      "targetTimeHour", "targetTimeMinute",
    }
    for _, sName in ipairs(numSettings) do
      local val = g_fsgSettings.settings:getValue(sName)
      if val ~= nil then
        setXMLInt(xmlFile, settingsKey .. "#" .. sName, tonumber(val) or 0)
      end
    end
    -- Also export targetTimeEnabled as bool
    local tgtEnabled = g_fsgSettings.settings:getValue("targetTimeEnabled")
    if tgtEnabled ~= nil then
      setXMLBool(xmlFile, settingsKey .. "#targetTimeEnabled", tgtEnabled == true)
    end
    -- Export current game timeScale
    local curScale = g_currentMission.missionInfo.timeScale or 1
    setXMLFloat(xmlFile, settingsKey .. "#timeScale", curScale)
  end

  saveXMLFile(xmlFile)
  delete(xmlFile)
end

-- Copy transactions file over to savegame
function onSave:copyTransactions()
  -- Save weather forecast to xml
  local savegameFolderPath = getUserProfileAppPath() .. "savegame" .. g_currentMission.missionInfo.savegameIndex
	local modSettingsFolderPath = getUserProfileAppPath()  .. "modSettings/" .. ((FSGSettings and FSGSettings.modName) or g_currentModName or "FS25_FSG_Companion") .. ""
	local moneyTransactionsFile = modSettingsFolderPath .. "/MoneyTransactions.xml"
	local moneyTransactionsFileSave = savegameFolderPath .. "/MoneyTransactions.xml"

  if ( fileExists(moneyTransactionsFile) ) then
    copyFile(moneyTransactionsFile, moneyTransactionsFileSave, true)
    deleteFile(moneyTransactionsFile)
  end
end

-- Copy transactions file over to savegame
function onSave:copyInboxLog()
  -- Save weather forecast to xml
  local savegameFolderPath = getUserProfileAppPath() .. "savegame" .. g_currentMission.missionInfo.savegameIndex
	local modSettingsFolderPath = getUserProfileAppPath()  .. "modSettings/" .. ((FSGSettings and FSGSettings.modName) or g_currentModName or "FS25_FSG_Companion") .. ""
	local inboxLogFile = modSettingsFolderPath .. "/InboxLog.xml"
	local inboxLogFileSave = savegameFolderPath .. "/InboxLog.xml"

  if ( fileExists(inboxLogFile) ) then
    copyFile(inboxLogFile, inboxLogFileSave, true)
    -- deleteFile(inboxLogFile)
  end
end

-- Export selling prices for all fill types + selling station best prices
function onSave.getSellingPrices()
  rcDebug("Building Selling Prices for bot.")
  if g_currentMission == nil or g_currentMission.economyManager == nil then return end

  local savegameFolderPath = getUserProfileAppPath() .. "savegame" .. g_currentMission.missionInfo.savegameIndex
  local savegameFile = savegameFolderPath .. "/sellingPrices.xml"
  local key = "sellingPrices"
  local xmlFile = createXMLFile(key, savegameFile, key)

  -- Get current game day and period for reference
  local environment = g_currentMission.environment
  if environment ~= nil then
    setXMLInt(xmlFile, key .. "#currentDay", environment.currentDay or 0)
    setXMLInt(xmlFile, key .. "#currentPeriod", environment.currentPeriod or 0)
  end

  -- Export base economy prices for all fill types
  local fillTypeIdx = 0
  local fillTypes = g_fillTypeManager:getFillTypes()
  for _, fillType in pairs(fillTypes) do
    if fillType ~= nil and fillType.index ~= nil and fillType.name ~= nil then
      local basePrice = g_currentMission.economyManager:getPricePerLiter(fillType.index)
      if basePrice ~= nil and basePrice > 0 then
        local ftKey = string.format(key .. ".fillType(%d)", fillTypeIdx)
        setXMLString(xmlFile, ftKey .. "#name", fillType.name)
        setXMLFloat(xmlFile, ftKey .. "#basePrice", basePrice)
        fillTypeIdx = fillTypeIdx + 1
      end
    end
  end

  -- Export best selling station prices per fill type
  local bestPrices = {}
  local sellingStations = g_currentMission.sellingStationManager
  if sellingStations ~= nil and sellingStations.sellingStations ~= nil then
    for _, station in pairs(sellingStations.sellingStations) do
      if station ~= nil and station.supportedFillTypes ~= nil then
        local stationName = ""
        if station.owningPlaceable ~= nil and station.owningPlaceable.getName ~= nil then
          stationName = station.owningPlaceable:getName() or ""
        end
        for fillTypeIndex, supported in pairs(station.supportedFillTypes) do
          if supported then
            local priceFactor = 1.0
            if station.fillTypePrices ~= nil and station.fillTypePrices[fillTypeIndex] ~= nil then
              local rawFactor = tonumber(station.fillTypePrices[fillTypeIndex])
              if rawFactor ~= nil and rawFactor > 0 then
                priceFactor = rawFactor
              end
            end
            local basePrice = g_currentMission.economyManager:getPricePerLiter(fillTypeIndex)
            basePrice = tonumber(basePrice)
            if basePrice ~= nil and basePrice > 0 then
              local effectivePrice = basePrice * priceFactor
              -- Check for great demand
              local isGreatDemand = false
              if station.isInGreatDemand ~= nil then
                isGreatDemand = station:isInGreatDemand(fillTypeIndex)
              end
              if isGreatDemand then
                local demandMult = tonumber(EconomyManager.GREAT_DEMAND_PRICE_MULTIPLIER) or 2.0
                effectivePrice = effectivePrice * demandMult
              end
              local fillTypeName = g_fillTypeManager:getFillTypeNameByIndex(fillTypeIndex)
              if fillTypeName ~= nil then
                if bestPrices[fillTypeName] == nil or effectivePrice > bestPrices[fillTypeName].price then
                  bestPrices[fillTypeName] = {
                    price = effectivePrice,
                    station = stationName,
                    isGreatDemand = isGreatDemand
                  }
                end
              end
            end
          end
        end
      end
    end
  end

  -- Write best prices
  local bestIdx = 0
  for fillTypeName, data in pairs(bestPrices) do
    local bpKey = string.format(key .. ".bestPrice(%d)", bestIdx)
    setXMLString(xmlFile, bpKey .. "#fillType", fillTypeName)
    setXMLFloat(xmlFile, bpKey .. "#price", data.price)
    setXMLString(xmlFile, bpKey .. "#station", data.station)
    setXMLBool(xmlFile, bpKey .. "#greatDemand", data.isGreatDemand)
    bestIdx = bestIdx + 1
  end

  saveXMLFile(xmlFile)
  delete(xmlFile)
end

-- Copy savegame file over to outbox for bot to get right away
function onSave:copySaveFileToOutbox(filename)
  rcDebug("onSave:copySaveFiles")
  -- paths where files do things
  local savegameFile = getUserProfileAppPath() .. "savegame" .. g_currentMission.missionInfo.savegameIndex .. "/" .. filename
  local savegameOutboxFile = getUserProfileAppPath()  .. "modSettings/" .. ((FSGSettings and FSGSettings.modName) or g_currentModName or "FS25_FSG_Companion") .. "/commands/outbox/" .. filename
  -- check to see if the file exist in the original folder then copy
  if ( fileExists(savegameFile) ) then
    rcDebug("Copy Savegame Filename: " .. filename)
    copyFile(savegameFile, savegameOutboxFile, true)
  end
end

-- Copy savegame xml files from savegame over to outbox
function onSave:copySaveFiles()
  rcDebug("onSave:copySaveFiles")
  -- copy files based on filename.xml
  onSave:copySaveFileToOutbox('environment.xml');
  onSave:copySaveFileToOutbox('farms.xml');
  onSave:copySaveFileToOutbox('WeatherForecast.xml');
  onSave:copySaveFileToOutbox('els_loans.xml');
  onSave:copySaveFileToOutbox('farmland.xml');
  onSave:copySaveFileToOutbox('careerSavegame.xml');
  onSave:copySaveFileToOutbox('economy.xml');
  onSave:copySaveFileToOutbox('fieldsStats.xml');
  onSave:copySaveFileToOutbox('animalStats.xml');
  onSave:copySaveFileToOutbox('productionStats.xml');
  onSave:copySaveFileToOutbox('placeableSiloStats.xml');
  onSave:copySaveFileToOutbox('placeableStats.xml');
  onSave:copySaveFileToOutbox('vehicleStats.xml');
  onSave:copySaveFileToOutbox('playerTimeStats.xml');
  onSave:copySaveFileToOutbox('playerStats.xml');
  onSave:copySaveFileToOutbox('farmPlayers.xml');
  onSave:copySaveFileToOutbox('vehicleUsageStats.xml');
  onSave:copySaveFileToOutbox('playerTracks.xml');
  onSave:copySaveFileToOutbox('playerSessionHistory.xml');
  onSave:copySaveFileToOutbox('sellingPrices.xml');
end

-- Copy savegame xml files from savegame over to outbox
function onSave:copyStatsSaveFiles()
  rcDebug("onSave:copyStatsSaveFiles")
  -- copy files based on filename.xml
  onSave:copySaveFileToOutbox('fieldsStats.xml');
  onSave:copySaveFileToOutbox('animalStats.xml');
  onSave:copySaveFileToOutbox('productionStats.xml');
  onSave:copySaveFileToOutbox('placeableSiloStats.xml');
  onSave:copySaveFileToOutbox('placeableStats.xml');
  onSave:copySaveFileToOutbox('vehicleStats.xml');
  onSave:copySaveFileToOutbox('playerTimeStats.xml');
  onSave:copySaveFileToOutbox('playerStats.xml');
  onSave:copySaveFileToOutbox('farmPlayers.xml');
  onSave:copySaveFileToOutbox('vehicleUsageStats.xml');
  onSave:copySaveFileToOutbox('playerTracks.xml');
  onSave:copySaveFileToOutbox('playerSessionHistory.xml');
end

-- Update xml link player stats
function onSave:updateStatsPlayers(superFunc)
	local xmlFile = self.statsXMLFile
	if xmlFile == nil then
		return
	elseif self.mission ~= nil then
		local userManager = self.mission.userManager
		local numUsed = userManager:getNumberOfUsers()
		if g_dedicatedServer ~= nil then
			numUsed = numUsed - 1
		end
		local capacity = self.mission.missionDynamicInfo.capacity or 0
		setXMLInt(xmlFile, "Server.Slots#capacity", capacity)
		setXMLInt(xmlFile, "Server.Slots#numUsed", numUsed)
		for i = 1, g_serverMaxCapacity do
			local playerKey = string.format("Server.Slots.Player(%d)", i - 1)
			removeXMLProperty(xmlFile, playerKey)
			if i <= capacity then
				local user = userManager:getUsers()[i + 1]
				if user == nil then
					setXMLBool(xmlFile, playerKey .. "#isUsed", false)
				else
					local connection = user:getConnection()
					local player
					if connection == nil then
						player = nil
					else
						player = self.mission.connectionsToPlayer[connection]
					end
					local playtime = (self.mission.time - user:getConnectedTime()) / 60000
					local uptime = math.round(playtime)
					setXMLBool(xmlFile, playerKey .. "#isUsed", true)
					setXMLBool(xmlFile, playerKey .. "#isAdmin", user:getIsMasterUser())
					setXMLInt(xmlFile, playerKey .. "#uptime", uptime)
          setXMLString(xmlFile, playerKey .. "#uniqueUserId", user:getUniqueUserId())
					if player ~= nil and (player.isControlled and (player.rootNode ~= nil and player.rootNode ~= 0)) then
						local x, y, z = getWorldTranslation(player.rootNode)
						setXMLFloat(xmlFile, playerKey .. "#x", x)
						setXMLFloat(xmlFile, playerKey .. "#y", y)
						setXMLFloat(xmlFile, playerKey .. "#z", z)
					end
					setXMLString(xmlFile, playerKey, HTMLUtil.encodeToHTML(user:getNickname(), true))
				end
			end
		end
	end
end