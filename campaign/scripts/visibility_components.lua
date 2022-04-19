function onInit()
	OptionsManager.registerCallback("SAIC", StateChanged);
	StateChanged();
end

function onClose()
	OptionsManager.unregisterCallback("SAIC", StateChanged);
end

function StateChanged()
	if OptionsManager.isOption("SAIC", "on") then
		setVisible(true);
		if LibraryData5E then
			setAnchoredWidth(50);
		else
			setAnchoredWidth(75);
		end
		setComponentsText();
	else
		setVisible(false);
	end
end

function setComponentsText()
	local sComponents = DB.getValue(window.getDatabaseNode(), "components", "");

	--Exception for e.g. Tome of Battle prerequisites, set all components with digits to empty
	if string.find(sComponents, "%d") then
		sComponents = "";
	end

	--Getting rid of spaces because of width
	sComponents = sComponents:gsub("%s", "");

	--Getting rid of paranthesis and text inbewteen for 5e
	sComponents = sComponents:gsub("%b()", "");

	setValue(sComponents);
end