


var loadmoreElement = document.getElementById("loadMore");
var BodyComic = document.getElementById("bodyComic");
var offset = 12;

loadmoreElement.addEventListener("click",()=>{
    fetch("comic/ajax/"+offset).then(response => response.json())
    .then(data_array => {
        data_array.forEach((data)=>{
        BodyComic.insertAdjacentHTML("beforeend", `
            <a style="text-decoration: none;" class="col-md-3" href="comic/show/`+data.id+`">

                <div class="d-flex align-items-center" style="height: 300px;  border-radius: 2.5%;  /*background-color: #3a3a3a;
                border-radius: 7px;*/"> 
                <img style="max-height: 100%;max-width: 100%;" src="public/uploads/`+data.savedFolder+`/`+data.coverImage+`" class="mx-auto d-block coverImage" alt="`+data.title+`">
                
                </div>
                <p class="text-justify text-white" style="overflow:hidden;">`+data.title+`</p>
            </a>
          `);
        })
        if(data_array.length == 0){
            loadmoreElement.remove();
        }
    });
    offset = offset + 12 // ose offset += 12

})